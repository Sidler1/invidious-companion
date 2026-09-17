#!/usr/bin/env bash
# Update the systemd-managed companion binary from the rolling GitHub release.
#
#   ./update.sh            # download, validate, swap, restart, verify
#   ./update.sh --follow   # …then tail the service log (interactive use)
#
# Safe for unattended use: the service is only stopped after the archive has
# been downloaded, validated and smoke-tested; the previous binary (if any)
# is kept as a .bak, and a failed restart rolls back to it.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/var/www/invidious-companion}"
SERVICE="${SERVICE:-invidious-companion}"
BINARY="invidious_companion"
ARCHIVE="invidious_companion-x86_64-unknown-linux-gnu.tar.gz"
URL="${URL:-https://github.com/Sidler1/invidious-companion/releases/download/release-master/${ARCHIVE}}"
START_GRACE_SECONDS=3  # time to let the new process crash-loop before trusting it

FOLLOW=false
if [ "${1:-}" = "--follow" ]; then
    FOLLOW=true
fi

log() { printf '[update] %s\n' "$*"; }
die() { printf '[update] ERROR: %s\n' "$*" >&2; exit 1; }

cd "${INSTALL_DIR}" || die "install dir ${INSTALL_DIR} not found"

WORKDIR="$(mktemp -d "${INSTALL_DIR}/.update.XXXXXX")"
trap 'rm -rf "${WORKDIR}"' EXIT

log "downloading ${URL}"
curl -fsSL --retry 3 --retry-delay 2 -o "${WORKDIR}/${ARCHIVE}" "${URL}" \
    || die "download failed"

log "validating archive"
tar -tzf "${WORKDIR}/${ARCHIVE}" >/dev/null || die "archive is corrupt"
tar -tzf "${WORKDIR}/${ARCHIVE}" | grep -qx "${BINARY}" \
    || die "archive does not contain ${BINARY}"
tar -xzf "${WORKDIR}/${ARCHIVE}" -C "${WORKDIR}" "${BINARY}"
chmod 0755 "${WORKDIR}/${BINARY}"

# The binary has no flag that validates itself and exits without booting the
# full server: parseConfig() runs unconditionally before any argument
# handling, so with an invalid/missing config it always exits non-zero, and
# with a valid one it binds a port and runs indefinitely instead of exiting
# 0. Neither makes a safe, side-effect-free "did this even execute" check.
# Inspect the ELF header instead -- it catches a wrong architecture or a
# corrupt download without ever running untrusted code or touching the
# service that's still up.
log "smoke-testing extracted binary"
command -v file >/dev/null 2>&1 \
    || die "the 'file' utility is required to validate the extracted binary but is not installed"
BINARY_FILE_INFO="$(file -b "${WORKDIR}/${BINARY}")"
if ! printf '%s' "${BINARY_FILE_INFO}" | grep -q 'ELF 64-bit.*x86-64'; then
    die "extracted binary is not an x86-64 ELF executable (file reports: ${BINARY_FILE_INFO}); wrong architecture or corrupt download?"
fi

if [ -f "${BINARY}" ] && cmp -s "${BINARY}" "${WORKDIR}/${BINARY}"; then
    log "already up to date; nothing to do"
    exit 0
fi

BACKUP_CREATED=false
rollback() {
    if [ "${BACKUP_CREATED}" = true ]; then
        log "restart failed; rolling back"
        mv -f "${BINARY}.bak" "${BINARY}"
        systemctl restart "${SERVICE}" || true
        die "update failed, previous binary restored"
    fi
    log "restart failed; no previous binary to roll back to"
    die "update failed and there is no previous binary to restore; ${SERVICE} is left stopped with the new binary in place"
}

log "stopping ${SERVICE}"
systemctl stop "${SERVICE}" || die "failed to stop ${SERVICE}; nothing was changed"

if [ -f "${BINARY}" ]; then
    cp -f "${BINARY}" "${BINARY}.bak"
    BACKUP_CREATED=true
else
    # Clear out any stale backup from an earlier run so rollback (which only
    # checks BACKUP_CREATED, not file existence) never restores it by mistake.
    rm -f "${BINARY}.bak"
fi
# Same filesystem as INSTALL_DIR, so the move is atomic.
mv -f "${WORKDIR}/${BINARY}" "${BINARY}"

log "starting ${SERVICE}"
systemctl start "${SERVICE}" || rollback

sleep "${START_GRACE_SECONDS}"
systemctl is-active --quiet "${SERVICE}" || rollback

log "updated successfully"
systemctl status --no-pager --lines=5 "${SERVICE}" || true

if [ "${FOLLOW}" = true ]; then
    journalctl -u "${SERVICE}" -f
fi
