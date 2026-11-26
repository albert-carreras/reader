#!/usr/bin/env bash
# One-time, needs sudo: install the reader-au tunnel token and its cloudflared connector unit.
#   sudo ./infra/install-connector.sh
# Expects the token at ~a/.config/reader/tunnel.token (written by `./stack tunnel`); deletes that copy afterwards.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
HOME_DIR=$(getent passwd "${SUDO_USER:-a}" | cut -d: -f6)
SRC="$HOME_DIR/.config/reader/tunnel.token"
HERE=$(cd "$(dirname "$0")" && pwd)
[[ -s "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }
install -d -m 0755 /etc/cloudflared
install -m 0600 -o root -g root "$SRC" /etc/cloudflared/reader.token
shred -u "$SRC" 2>/dev/null || rm -f "$SRC"
install -m 0644 "$HERE/systemd/cloudflared-reader.service" /etc/systemd/system/cloudflared-reader.service
systemctl daemon-reload
systemctl enable --now cloudflared-reader
sleep 3
systemctl --no-pager --lines=5 status cloudflared-reader
