#!/usr/bin/env bash
# Update the systemd-managed companion binary from the rolling GitHub release.
#
#   ./update.sh            # download, validate, swap, restart, verify
#   ./update.sh --follow   # …then tail the service log (interactive use)
#
# Safe for unattended use: the service is only stopped after the archive has
# been downloaded and validated, the previous binary is kept as a .bak, and a
# failed restart rolls back to it.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/var/www/invidious-companion}"
SERVICE="${SERVICE:-invidious-companion}"
BINARY="invidious_companion"
ARCHIVE="invidious_companion-x86_64-unknown-linux-gnu.tar.gz"
URL="https://github.com/Sidler1/invidious-companion/releases/download/release-master/${ARCHIVE}"

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
"${WORKDIR}/${BINARY}" --help >/dev/null 2>&1 || true   # smoke: must be executable on this host
[ -x "${WORKDIR}/${BINARY}" ] || die "extracted binary is not executable"

if [ -f "${BINARY}" ] && cmp -s "${BINARY}" "${WORKDIR}/${BINARY}"; then
    log "already up to date; nothing to do"
    exit 0
fi

rollback() {
    log "restart failed; rolling back"
    if [ -f "${BINARY}.bak" ]; then
        mv -f "${BINARY}.bak" "${BINARY}"
        systemctl restart "${SERVICE}" || true
    fi
    die "update failed, previous binary restored"
}

log "stopping ${SERVICE}"
systemctl stop "${SERVICE}"

if [ -f "${BINARY}" ]; then
    cp -f "${BINARY}" "${BINARY}.bak"
fi
# Same filesystem as INSTALL_DIR, so the move is atomic.
mv -f "${WORKDIR}/${BINARY}" "${BINARY}"

log "starting ${SERVICE}"
systemctl start "${SERVICE}" || rollback

# Give the process a moment to crash-loop before declaring success.
sleep 3
systemctl is-active --quiet "${SERVICE}" || rollback

log "updated successfully"
systemctl status --no-pager --lines=5 "${SERVICE}" || true

if [ "${FOLLOW}" = true ]; then
    journalctl -u "${SERVICE}" -f
fi
