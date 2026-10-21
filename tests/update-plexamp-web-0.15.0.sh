#!/bin/sh
# Updates plexamp-web to the newest tested version; settings are kept.
set -eu
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "https://raw.githubusercontent.com/kamakazedan/plexamp-web/stable/proxmox/install.sh" -o "$tmp" 2>/dev/null ||
    curl -fsSL "https://raw.githubusercontent.com/kamakazedan/plexamp-web/main/proxmox/install.sh" -o "$tmp"
LC_ALL=C.UTF-8 PW_REPO="kamakazedan/plexamp-web" PW_REF="stable" bash "$tmp"
