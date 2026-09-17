#!/usr/bin/env bash
# Single source of truth for `deno compile`. Called by `deno task compile`
# (host build, Dockerfile builder stage) and by the release workflow, which
# passes `--target=<triple>`. Any arguments are forwarded to `deno compile`
# ahead of the entrypoint; COMPILE_OUTPUT overrides the output path.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUTPUT="${COMPILE_OUTPUT:-invidious_companion}"
VERSION_DATE="$(git log -1 --format=%ci | awk '{print $1}' | sed s/-/./g)"
VERSION_COMMIT="$(git rev-list HEAD --max-count=1 --abbrev-commit)"

# --allow-read below is deliberately unrestricted (matches the Docker image's
# runtime permissions): CONFIG_FILE and CACHE_DIRECTORY are operator-
# configurable to arbitrary paths outside the working directory, so a
# narrower list here breaks those on the release binaries built from this
# script.
exec deno compile \
    --include ./src/lib/helpers/youtubePlayerReq.ts \
    --include ./src/lib/helpers/getFetchClient.ts \
    --allow-import=github.com:443,jsr.io:443,cdn.jsdelivr.net:443,esm.sh:443,deno.land:443 \
    --allow-net \
    --allow-env \
    --allow-read \
    --allow-sys=hostname \
    --allow-write=/var/tmp/youtubei.js,/tmp/invidious-companion.sock,/tmp/companionsock \
    --output "${OUTPUT}" \
    "$@" \
    src/main.ts \
    --_version_date="${VERSION_DATE}" \
    --_version_commit="${VERSION_COMMIT}"
