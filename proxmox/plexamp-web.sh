#!/usr/bin/env bash
# plexamp-web on Proxmox VE: makes a small Debian container (LXC) on this
# node and installs plexamp-web in it, in the manner of the Proxmox VE
# community helper scripts.
#
# On the node's shell (as root):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/stable/proxmox/plexamp-web.sh)"
#
# It offers its default settings, or asks about each one ("advanced"). Any
# of them can be set beforehand instead, and with YES=1 it asks nothing:
#
#   CTID CT_HOSTNAME CORES RAM_MB DISK_GB STORAGE TEMPLATE_STORAGE BRIDGE
#   IP (dhcp, or an address like 192.168.1.50/24) GATEWAY
#   PLEX_SERVER_URL OLLAMA_URL OLLAMA_MODEL MUSICBRAINZ_URL
#
# The container is unprivileged, starts with the node, and runs nginx and
# Node.js from Debian (no Docker). Inside it, `update-plexamp-web` updates
# the app and `plexamp-web-settings` changes its settings.
#
# PW_VERBOSE=1 (or --verbose) shows every step in detail, with the tools'
# own output, the install inside the container included.
set -euo pipefail

# All of it is in main(), which the last line runs: if the download that
# `bash -c "$(curl …)"` runs stopped partway, none of it runs.
main() {

REPO="${PW_REPO:-kamakazedan/plexamp-web}"
REF="${PW_REF:-stable}"
verbose=false
case "${PW_VERBOSE:-}" in 1 | true | yes) verbose=true ;; esac
for arg in "$@"; do
    case "$arg" in
        -v | --verbose) verbose=true ;;
        *)
            printf 'There is no option %s (the only one is --verbose).\n' "$arg" >&2
            exit 2
            ;;
    esac
done

# ---------- output ----------

if [ -t 1 ]; then
    BOLD=$'\033[1m' DIM=$'\033[2m' CYAN=$'\033[1;36m' GREEN=$'\033[1;32m' RED=$'\033[1;31m' YELLOW=$'\033[1;33m' RESET=$'\033[0m'
    LIVE=true
else
    BOLD='' DIM='' CYAN='' GREEN='' RED='' YELLOW='' RESET=''
    LIVE=false
fi
# (In detail, lines aren't rewritten: the tools' own output goes between them.)
if [ "$verbose" = true ]; then LIVE=false; fi
STEP=""
# A step starting, and done (the line is rewritten in a terminal).
info() {
    if [ "$LIVE" = true ] && [ -n "$STEP" ]; then printf '\r\033[K'; fi
    STEP="$*"
    if [ "$LIVE" = true ]; then printf '  %s…%s %s' "$YELLOW" "$RESET" "$STEP"; else printf '  … %s\n' "$STEP"; fi
}
ok() {
    if [ "$LIVE" = true ] && [ -n "$STEP" ]; then printf '\r\033[K'; fi
    printf '  %s✔%s %s\n' "$GREEN" "$RESET" "${1:-$STEP}"
    STEP=""
}
fail() {
    if [ "$LIVE" = true ] && [ -n "$STEP" ]; then printf '\r\033[K'; fi
    STEP=""
    printf '  %s✖%s %s\n' "$RED" "$RESET" "$*" >&2
    exit 1
}
item() { printf '    %s%-13s%s %s\n' "$DIM" "$1" "$RESET" "$2"; }
# quietly CMD...: runs CMD, its output shown (indented, after the command)
# only in detail; its errors are shown either way.
quietly() {
    if [ "$verbose" = true ]; then
        local status=0
        printf '    %s%s%s\n' "$DIM" "$*" "$RESET"
        "$@" 2>&1 | sed -u 's/^/      /' || status=$?
        return "$status"
    fi
    "$@" >/dev/null
}

header() {
    printf '%s' "$CYAN"
    cat <<'ART'

         _                                                 _
   _ __ | | ___ __ __ __ _  _ __   _ __      __ __ __ ___ | |__
  | '_ \| |/ -_)\ \ // _` || '  \ | '_ \ ___ \ V  V // -_)| '_ \
  | .__/|_|\___|/_\_\\__,_||_|_|_|| .__/      \_/\_/ \___||_.__/
  |_|                             |_|
ART
    printf '%s\n  %sA Plexamp-style web player for your Plex music, in its own container.%s\n\n' "$RESET" "$DIM" "$RESET"
}

header

# ---------- checks ----------

[ "$(id -u)" = 0 ] || fail "Run this as root, on the Proxmox VE node's shell."
for tool in pct pveam pvesm pvesh; do
    command -v "$tool" >/dev/null 2>&1 || fail "This runs on a Proxmox VE node ($tool wasn't found)."
done
pve_full="$(pveversion 2>/dev/null | sed -n 's#^pve-manager/\([0-9][0-9.]*\)/.*#\1#p')"
pve="${pve_full%%.*}"
if [ -z "$pve" ] || [ "$pve" -lt 8 ]; then fail "This needs Proxmox VE 8 or later."; fi
arch="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "PW_REPO should look like owner/name."
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ ]] || fail "PW_REF should be a branch or tag name."
ok "Proxmox VE $pve_full ($arch)"

# ---------- settings ----------

tty=false
if [ "${YES:-}" != 1 ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then tty=true; fi

# ask VAR "Question" default: the answer goes in VAR (already set: kept;
# default settings or no terminal: the default).
advanced=false
ask() {
    local var="$1" question="$2" def="${3:-}" answer
    if [ -n "${!var:-}" ]; then return; fi
    if [ "$tty" = true ] && [ "$advanced" = true ]; then
        read -r -p "  $question${def:+ [$def]}: " answer </dev/tty || answer=""
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

# Storages with this content that are active.
storages() { pvesm status -content "$1" 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }'; }

# one_of VALUE CHOICE...: VALUE is one of the choices, exactly.
one_of() {
    local want="$1" choice
    shift
    for choice in "$@"; do
        if [ "$choice" = "$want" ]; then return 0; fi
    done
    return 1
}

# download URL FILE: 0 when all of it arrived, 2 when GitHub says there's no
# such thing (404), 1 when it couldn't be fetched (or stopped partway).
download() {
    local code ok=true
    code="$(curl -sSL -o "$2" -w '%{http_code}' "$1" 2>/dev/null)" || ok=false
    if [ "$ok" = true ] && [ "$code" = 200 ]; then return 0; fi
    if [ "$ok" = true ] && [ "$code" = 404 ]; then return 2; fi
    return 1
}

URL_RE='^$|^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$|^https?://\[[0-9A-Fa-f:.]+\](:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'

if [ "$tty" = true ]; then
    read -r -p "  Use the default settings? [Y/n] (n: choose each one) " answer </dev/tty || answer=""
    case "$answer" in [nN]*) advanced=true ;; esac
    echo
fi

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
    if one_of "$s" "${disk_choices[@]}"; then default_disk="$s" && break; fi
done
ask STORAGE "Storage for its disk (${disk_choices[*]})" "$default_disk"
one_of "$STORAGE" "${disk_choices[@]}" || fail "$STORAGE can't hold containers (choose from: ${disk_choices[*]})."

mapfile -t template_choices < <(storages vztmpl)
[ "${#template_choices[@]}" -gt 0 ] || fail "No storage here can hold container templates."
default_tmpl="${template_choices[0]}"
if one_of local "${template_choices[@]}"; then default_tmpl=local; fi
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$default_tmpl}"
one_of "$TEMPLATE_STORAGE" "${template_choices[@]}" || fail "$TEMPLATE_STORAGE can't hold templates."

ask CORES "CPU cores" 1
ask RAM_MB "Memory (MB)" 512
ask DISK_GB "Disk (GB)" 4
valid CORES "The number of cores" '^([1-9]|[1-5][0-9]|6[0-4])$'
valid RAM_MB "The memory" '^[1-9][0-9]{2,5}$'
valid DISK_GB "The disk size" '^[1-9][0-9]{0,3}$'
[ "$RAM_MB" -ge 256 ] || fail "The memory should be at least 256 MB."
[ "$DISK_GB" -ge 2 ] || fail "The disk should be at least 2 GB."

ask BRIDGE "Network bridge" "vmbr0"
valid BRIDGE "The bridge" '^[A-Za-z0-9_.-]{1,15}$'
ask IP "Address: dhcp, or a fixed one like 192.168.1.50/24" "dhcp"
valid IP "The address" '^dhcp$|^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
if [ "$IP" != dhcp ]; then
    ask GATEWAY "Gateway" ""
    valid GATEWAY "The gateway" '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
fi

ask PLEX_SERVER_URL "Your Plex server's address, like http://192.168.1.10:32400 (Enter to skip)" ""
valid PLEX_SERVER_URL "The Plex server's address" "$URL_RE"
ask OLLAMA_URL "An Ollama server for AI playlists, like http://192.168.1.20:11434 (Enter to skip)" ""
valid OLLAMA_URL "The Ollama address" "$URL_RE"
if [ -n "$OLLAMA_URL" ]; then
    ask OLLAMA_MODEL "Its model, like llama3.1:8b" ""
fi
OLLAMA_MODEL="${OLLAMA_MODEL:-}"
valid OLLAMA_MODEL "The model" '^[A-Za-z0-9._:/@+-]*$'
ask MUSICBRAINZ_URL "A MusicBrainz to check AI playlists' suggestions with: https://musicbrainz.org, or your own (Enter to skip)" ""
valid MUSICBRAINZ_URL "The MusicBrainz address" "$URL_RE"

cpus="$CORES cores"
[ "$CORES" != 1 ] || cpus="1 core"
network="DHCP"
[ "$IP" = dhcp ] || network="$IP via $GATEWAY"
which="Default"
[ "$advanced" = true ] || echo
if [ "$advanced" = true ]; then
    which="Your"
    echo
fi
printf '  %s%s settings%s\n' "$BOLD" "$which" "$RESET"
item "Container" "$CTID, named $CT_HOSTNAME (unprivileged Debian, starts with the node)"
item "Size" "$cpus, $RAM_MB MB memory, $DISK_GB GB disk on $STORAGE"
item "Network" "$network on $BRIDGE"
item "Plex server" "${PLEX_SERVER_URL:-not set (it can be set later)}"
item "AI (Ollama)" "${OLLAMA_URL:-not set}${OLLAMA_MODEL:+, $OLLAMA_MODEL}"
[ -z "$MUSICBRAINZ_URL" ] || item "MusicBrainz" "$MUSICBRAINZ_URL"
echo
if [ "$tty" = true ]; then
    read -r -p "  Make it? [Y/n] " go </dev/tty || go=n
    case "$go" in [nN]*) fail "Nothing was made." ;; esac
    echo
fi

# ---------- template ----------

# The newest Debian template (13, or else 12) for this machine.
pick() { grep -Eo "debian-1[23]-standard_[0-9][0-9.]*-[0-9]+_${arch}\.tar\.(zst|gz|xz)" | sort -V | tail -n 1; }
info "Looking for a Debian template"
template="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | pick || true)"
if [ -z "$template" ]; then
    info "Downloading a Debian template"
    quietly pveam update || true
    template="$(pveam available --section system 2>/dev/null | pick || true)"
    [ -n "$template" ] || fail "No Debian 12 or 13 template for $arch was found (pveam available --section system)."
    quietly pveam download "$TEMPLATE_STORAGE" "$template" || fail "The template $template couldn't be downloaded."
fi
ok "Template ${template%%_"$arch"*} on $TEMPLATE_STORAGE"

# ---------- the container ----------

net="name=eth0,bridge=$BRIDGE,ip=$IP${GATEWAY:+,gw=$GATEWAY}"
made=false
work=""
# If something goes wrong after this, say how to remove what was made.
finish() {
    local code=$?
    if [ -n "$work" ]; then rm -rf "$work"; fi
    if [ "$code" != 0 ] && [ "$made" = true ]; then
        printf '\n  Container %s was made, but plexamp-web was not installed. To remove it: pct stop %s; pct destroy %s\n' "$CTID" "$CTID" "$CTID" >&2
    fi
}
trap finish EXIT
info "Making container $CTID"
quietly pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$template" \
    --hostname "$CT_HOSTNAME" \
    --cores "$CORES" --memory "$RAM_MB" --swap 512 \
    --rootfs "$STORAGE:$DISK_GB" \
    --net0 "$net" \
    --unprivileged 1 --features nesting=1 \
    --onboot 1 --ostype debian --timezone host \
    --tags plexamp-web \
    --description "plexamp-web: https://github.com/$REPO" || fail "Container $CTID couldn't be made."
made=true
ok "Made container $CTID"
info "Starting it"
pct start "$CTID" || fail "Container $CTID didn't start."
ok "Started container $CTID"

info "Waiting for its network"
for _ in $(seq 1 60); do
    if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
    sleep 1
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || fail "Container $CTID can't reach the internet (check its network: pct config $CTID)."
address="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{ print $1 }')"
ok "Network up${address:+: $address}"

# Settings: written here and copied in, so nothing typed above passes through
# a shell inside the container.
work="$(mktemp -d)"
cat >"$work/plexamp-web.env" <<ENV
# plexamp-web settings, the same as the Docker image's (see
# docs/configuration.md). Change them with: plexamp-web-settings
PLEX_SERVER_URL=$PLEX_SERVER_URL
DISABLE_WEBSOCKETS=
OLLAMA_URL=$OLLAMA_URL
OLLAMA_MODEL=$OLLAMA_MODEL
OLLAMA_API_KEY=
OLLAMA_AUTH=plex
PLAY_TOGETHER=true
CASTING=true
PLAYLIST_SHARING=true
# MusicBrainz, to check the suggestions in AI playlists: https://musicbrainz.org
# (the public service) or your own mirror. Empty: no checks.
MUSICBRAINZ_URL=$MUSICBRAINZ_URL
# true: Search › From Spotify makes a playlist from a Spotify playlist's link,
# read from Spotify's public page for it (see docs/configuration.md).
SPOTIFY_IMPORT=
DEBUG=
ENV
pct exec "$CTID" -- mkdir -p /etc/plexamp-web
pct push "$CTID" "$work/plexamp-web.env" /etc/plexamp-web/plexamp-web.env --perms 600

# The installer: next to this script when it's run from a copy of the repo
# (bash proxmox/plexamp-web.sh), otherwise (bash -c "$(curl …)") from GitHub:
# the stable branch (the commits that passed every test), or main if there's
# no stable branch yet (only then: a download that failed is no reason to
# install something untested).
here=""
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then here="$(cd "$(dirname "$src")" && pwd)"; fi
if [ -n "${PW_INSTALL_SCRIPT:-}" ]; then
    cp "$PW_INSTALL_SCRIPT" "$work/install.sh"
elif [ -n "$here" ] && [ -f "$here/install.sh" ] && [ -f "$here/plexamp-web.sh" ]; then
    cp "$here/install.sh" "$work/install.sh"
else
    got=0
    download "https://raw.githubusercontent.com/$REPO/$REF/proxmox/install.sh" "$work/install.sh" || got=$?
    if [ "$got" = 2 ] && [ "$REF" = stable ]; then
        got=0
        download "https://raw.githubusercontent.com/$REPO/main/proxmox/install.sh" "$work/install.sh" || got=$?
    fi
    [ "$got" = 0 ] || fail "Couldn't download the installer ($REPO, $REF). Nothing was installed in container $CTID."
fi
pct push "$CTID" "$work/install.sh" /root/install-plexamp-web.sh --perms 700
printf '  %sInstalling plexamp-web in it (a minute or two)%s\n' "$BOLD" "$RESET"
# (LC_ALL: the node's own language setting may not exist in the container,
# and Debian's tools would complain about it.)
install_env=(LC_ALL=C.UTF-8 "PW_REPO=$REPO" "PW_REF=$REF")
if [ "$verbose" = true ]; then install_env+=(PW_VERBOSE=1); fi
pct exec "$CTID" -- env "${install_env[@]}" bash /root/install-plexamp-web.sh || fail "The install in container $CTID didn't finish (see above)."
pct exec "$CTID" -- rm -f /root/install-plexamp-web.sh

[ -n "$address" ] || address="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{ print $1 }')"
[ -n "$address" ] || address="this-container's-address"
echo
printf '  %s✔ plexamp-web is ready: %shttp://%s/%s\n' "$GREEN" "$BOLD" "$address" "$RESET"
printf '    Open it, choose Sign in with Plex, then pick your server and music library.\n\n'
if [ -z "$PLEX_SERVER_URL" ]; then
    printf '    %sTip:%s set your Plex server'"'"'s address (PLEX_SERVER_URL), so the player can reach it\n' "$BOLD" "$RESET"
    printf '    on your network: pct exec %s -- plexamp-web-settings\n\n' "$CTID"
fi
item "Settings" "pct exec $CTID -- plexamp-web-settings"
item "Updates" "pct exec $CTID -- update-plexamp-web (--verbose to follow each step)"
item "Logs" "pct exec $CTID -- journalctl -u plexamp-web -u plexamp-web-config -f"
echo
}

main "$@"
