#!/usr/bin/env bash
set -euo pipefail

cd /var/www/invidious-companion/

URL="https://github.com/Sidler1/invidious-companion/releases/download/release-master/invidious_companion-x86_64-unknown-linux-gnu.tar.gz"
TARBALL="invidious_companion-x86_64-unknown-linux-gnu.tar.gz"

wget -O "$TARBALL" "$URL"
systemctl stop invidious-companion
tar xzf "$TARBALL"
rm -f "$TARBALL"
systemctl start invidious-companion

journalctl -u invidious-companion -f