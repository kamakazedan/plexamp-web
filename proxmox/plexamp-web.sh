#!/usr/bin/env bash
# plexamp-web on Proxmox VE: makes a small Debian container (LXC) on this
# node and installs plexamp-web in it.
#
# On the node's shell (as root):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/main/proxmox/plexamp-web.sh)"
#
# It asks a few questions; Enter keeps the suggestion. Any answer can be set
# beforehand instead, and with YES=1 it asks nothing:
#
#   CTID CT_HOSTNAME CORES RAM_MB DISK_GB STORAGE TEMPLATE_STORAGE BRIDGE
#   IP (dhcp, or an address like 192.168.1.50/24) GATEWAY
#   PLEX_SERVER_URL OLLAMA_URL OLLAMA_MODEL
#
# The container is unprivileged, starts with the node, and runs nginx and
# Node.js from Debian (no Docker). Inside it, `update-plexamp-web` updates
# the app; its settings are in /etc/plexamp-web/plexamp-web.env.
set -euo pipefail

REPO="${PW_REPO:-kamakazedan/plexamp-web}"
REF="${PW_REF:-main}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() {
    printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
    exit 1
}

# ---------- checks ----------

[ "$(id -u)" = 0 ] || fail "Run this as root, on the Proxmox VE node's shell."
for tool in pct pveam pvesm pvesh; do
    command -v "$tool" >/dev/null 2>&1 || fail "This runs on a Proxmox VE node ($tool wasn't found)."
done
pve="$(pveversion 2>/dev/null | sed -n 's#^pve-manager/\([0-9]*\)\..*#\1#p')"
if [ -z "$pve" ] || [ "$pve" -lt 8 ]; then fail "This needs Proxmox VE 8 or later."; fi
arch="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
printf '%s\n' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fail "PW_REPO should look like owner/name."
printf '%s\n' "$REF" | grep -Eq '^[A-Za-z0-9_./-]+$' || fail "PW_REF should be a branch or tag name."

# ---------- questions ----------

tty=false
if [ "${YES:-}" != 1 ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then tty=true; fi

# ask VAR "Question" default: the answer goes in VAR (already set: kept).
ask() {
    local var="$1" question="$2" def="${3:-}" answer
    if [ -n "${!var:-}" ]; then return; fi
    if [ "$tty" = true ]; then
        read -r -p "$question${def:+ [$def]}: " answer </dev/tty || answer=""
        printf -v "$var" '%s' "${answer:-$def}"
    else
        printf -v "$var" '%s' "$def"
    fi
}

# valid VAR "what it is" regex: refuse anything else (these end up in
# commands and settings files). The whole value must match: one line, no
# quotes or shell characters.
valid() {
    local var="$1" what="$2" re="$3"
    [[ "${!var}" =~ $re ]] || fail "$what isn't right: ${!var}"
}

# The first storage, of those with this content, that's active.
storages() { pvesm status -content "$1" 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }'; }

# Your settings for the app, before anything is made.
URL_RE='^$|^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$|^https?://\[[0-9A-Fa-f:.]+\](:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'

next_id="$(pvesh get /cluster/nextid 2>/dev/null || echo 100)"
ask CTID "Container ID" "$next_id"
valid CTID "The container ID" '^[1-9][0-9]{2,8}$'
if pct status "$CTID" >/dev/null 2>&1; then fail "There's already a container or VM $CTID."; fi
# (Not HOSTNAME: bash sets that to this node's own name.)
ask CT_HOSTNAME "Name" "plexamp-web"
valid CT_HOSTNAME "The name" '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

mapfile -t disk_choices < <(storages rootdir)
[ "${#disk_choices[@]}" -gt 0 ] || fail "No storage here can hold containers."
default_disk="${disk_choices[0]}"
for s in local-lvm local-zfs; do
    if printf '%s\n' "${disk_choices[@]}" | grep -qx "$s"; then default_disk="$s" && break; fi
done
[ "$tty" = true ] && [ "${#disk_choices[@]}" -gt 1 ] && [ -z "${STORAGE:-}" ] && say "Storage for containers: ${disk_choices[*]}"
ask STORAGE "Storage" "$default_disk"
printf '%s\n' "${disk_choices[@]}" | grep -qx -- "$STORAGE" || fail "$STORAGE can't hold containers (choose from: ${disk_choices[*]})."

mapfile -t template_choices < <(storages vztmpl)
[ "${#template_choices[@]}" -gt 0 ] || fail "No storage here can hold container templates."
default_tmpl="${template_choices[0]}"
if printf '%s\n' "${template_choices[@]}" | grep -qx local; then default_tmpl=local; fi
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$default_tmpl}"
printf '%s\n' "${template_choices[@]}" | grep -qx -- "$TEMPLATE_STORAGE" || fail "$TEMPLATE_STORAGE can't hold templates."

ask IP "Network: dhcp, or a fixed address like 192.168.1.50/24" "dhcp"
valid IP "The address" '^dhcp$|^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
if [ "$IP" != dhcp ]; then
    ask GATEWAY "Gateway" ""
    valid GATEWAY "The gateway" '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
fi
BRIDGE="${BRIDGE:-vmbr0}"
valid BRIDGE "The bridge" '^[A-Za-z0-9_.-]{1,15}$'

ask PLEX_SERVER_URL "Your Plex server's address, like http://192.168.1.10:32400 (Enter to skip)" ""
valid PLEX_SERVER_URL "The Plex server's address" "$URL_RE"
ask OLLAMA_URL "An Ollama server for AI playlists, like http://192.168.1.20:11434 (Enter to skip)" ""
valid OLLAMA_URL "The Ollama address" "$URL_RE"
if [ -n "$OLLAMA_URL" ]; then
    ask OLLAMA_MODEL "Its model, like llama3.1:8b" ""
fi
OLLAMA_MODEL="${OLLAMA_MODEL:-}"
valid OLLAMA_MODEL "The model" '^[A-Za-z0-9._:/@+-]*$'

CORES="${CORES:-1}"
RAM_MB="${RAM_MB:-512}"
DISK_GB="${DISK_GB:-4}"
valid CORES "CORES" '^([1-9]|[1-5][0-9]|6[0-4])$'
valid RAM_MB "RAM_MB" '^[1-9][0-9]{2,5}$'
valid DISK_GB "DISK_GB" '^[1-9][0-9]{0,3}$'
[ "$RAM_MB" -ge 256 ] || fail "RAM_MB should be at least 256."
[ "$DISK_GB" -ge 2 ] || fail "DISK_GB should be at least 2."

echo
cores="$CORES cores"
[ "$CORES" != 1 ] || cores="1 core"
say "Container $CTID ($CT_HOSTNAME): $cores, $RAM_MB MB, $DISK_GB GB on $STORAGE, network $IP${GATEWAY:+ via $GATEWAY} on $BRIDGE"
say "Plex server: ${PLEX_SERVER_URL:-not set}; Ollama: ${OLLAMA_URL:-not set}${OLLAMA_MODEL:+ ($OLLAMA_MODEL)}"
if [ "$tty" = true ]; then
    read -r -p "Make it? [Y/n] " go </dev/tty || go=n
    case "$go" in [nN]*) fail "Nothing was made." ;; esac
fi

# ---------- template ----------

# The newest Debian template (13, or else 12) for this machine.
pick() { grep -Eo "debian-1[23]-standard_[0-9][0-9.]*-[0-9]+_${arch}\.tar\.(zst|gz|xz)" | sort -V | tail -n 1; }
template="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | pick || true)"
if [ -z "$template" ]; then
    say "Downloading a Debian template"
    pveam update >/dev/null || true
    template="$(pveam available --section system 2>/dev/null | pick || true)"
    [ -n "$template" ] || fail "No Debian 12 or 13 template for $arch was found (pveam available --section system)."
    pveam download "$TEMPLATE_STORAGE" "$template" >/dev/null || fail "The template $template couldn't be downloaded."
fi
say "Template: $template"

# ---------- the container ----------

net="name=eth0,bridge=$BRIDGE,ip=$IP${GATEWAY:+,gw=$GATEWAY}"
made=false
work=""
# If something goes wrong after this, say how to remove what was made.
finish() {
    local code=$?
    if [ -n "$work" ]; then rm -rf "$work"; fi
    if [ "$code" != 0 ] && [ "$made" = true ]; then
        printf '\nContainer %s was made, but plexamp-web was not installed. To remove it: pct stop %s; pct destroy %s\n' "$CTID" "$CTID" "$CTID" >&2
    fi
}
trap finish EXIT
say "Making container $CTID"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$template" \
    --hostname "$CT_HOSTNAME" \
    --cores "$CORES" --memory "$RAM_MB" --swap 512 \
    --rootfs "$STORAGE:$DISK_GB" \
    --net0 "$net" \
    --unprivileged 1 --features nesting=1 \
    --onboot 1 --ostype debian --timezone host \
    --tags plexamp-web \
    --description "plexamp-web: https://github.com/$REPO" >/dev/null
made=true
pct start "$CTID"

say "Waiting for its network"
for _ in $(seq 1 60); do
    if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
    sleep 1
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || fail "Container $CTID can't reach the internet (check its network: pct config $CTID)."

# Settings: written here and copied in, so nothing typed above passes through
# a shell inside the container.
work="$(mktemp -d)"
cat >"$work/plexamp-web.env" <<ENV
# plexamp-web settings (the same as the Docker image's; see the README).
# After a change: systemctl restart plexamp-web-config nginx plexamp-web
PLEX_SERVER_URL=$PLEX_SERVER_URL
OLLAMA_URL=$OLLAMA_URL
OLLAMA_MODEL=$OLLAMA_MODEL
ENV
pct exec "$CTID" -- mkdir -p /etc/plexamp-web
pct push "$CTID" "$work/plexamp-web.env" /etc/plexamp-web/plexamp-web.env --perms 600

# The installer: next to this script when it's run from a copy of the repo
# (bash proxmox/plexamp-web.sh), otherwise (bash -c "$(curl …)") from GitHub.
here=""
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then here="$(cd "$(dirname "$src")" && pwd)"; fi
if [ -n "${PW_INSTALL_SCRIPT:-}" ]; then
    cp "$PW_INSTALL_SCRIPT" "$work/install.sh"
elif [ -n "$here" ] && [ -f "$here/install.sh" ] && [ -f "$here/plexamp-web.sh" ]; then
    cp "$here/install.sh" "$work/install.sh"
else
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/proxmox/install.sh" -o "$work/install.sh" || fail "Couldn't download the installer."
fi
pct push "$CTID" "$work/install.sh" /root/install-plexamp-web.sh --perms 700
say "Installing plexamp-web in container $CTID (this takes a minute or two)"
pct exec "$CTID" -- env PW_REPO="$REPO" PW_REF="$REF" bash /root/install-plexamp-web.sh
pct exec "$CTID" -- rm -f /root/install-plexamp-web.sh

address="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{ print $1 }')"
echo
[ -n "$address" ] || address="this-container's-address"
say "plexamp-web is ready: http://$address/"
say "Settings: pct enter $CTID, then edit /etc/plexamp-web/plexamp-web.env and run: systemctl restart plexamp-web-config nginx plexamp-web"
say "Updates: pct exec $CTID -- update-plexamp-web"
