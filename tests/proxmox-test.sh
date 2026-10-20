#!/usr/bin/env bash
# Tests proxmox/plexamp-web.sh on any Linux machine, with stand-ins for the
# Proxmox VE tools (pct, pveam, pvesm, pvesh, pveversion): the container it
# makes, the settings it writes, and what it refuses. Used by CI.
#
#   bash tests/proxmox-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/proxmox/plexamp-web.sh"
FAILED=0
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

pass() { echo "PASS $1"; }
fail() {
    echo "FAIL $1"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error title=Proxmox script test::$1"; fi
    FAILED=1
}

# ---------- stand-ins ----------

mkdir -p "$T/bin"
stub() { # name, body (bash)
    printf '#!/usr/bin/env bash\nS=%q\n%s\n' "$T" "$2" >"$T/bin/$1"
    chmod +x "$T/bin/$1"
}
stub id 'if [ "${1:-}" = -u ]; then cat "$S/uid" 2>/dev/null || echo 0; else /usr/bin/id "$@"; fi'
stub dpkg 'echo amd64'
stub pveversion 'cat "$S/pveversion"'
stub pvesh '[ "$*" = "get /cluster/nextid" ] && echo 123'
stub pvesm 'echo "Name Type Status Total Used Available %"
case "$*" in
  "status -content rootdir") echo "local-lvm lvmthin active 100 1 99 1%"; echo "tank zfspool active 100 1 99 1%" ;;
  "status -content vztmpl") echo "local dir active 100 1 99 1%" ;;
esac'
stub pveam 'echo "pveam $*" >>"$S/calls"
case "$1" in
  list) [ -f "$S/have-template" ] && echo "local:vztmpl/$(cat "$S/have-template")  120MB" ;;
  available) printf "system  debian-11-standard_11.7-1_amd64.tar.zst\nsystem  debian-12-standard_12.7-1_amd64.tar.zst\nsystem  debian-13-standard_13.1-2_amd64.tar.zst\nsystem  ubuntu-24.04-standard_24.04-2_amd64.tar.zst\n" ;;
  download) echo "$3" >"$S/have-template" ;;
esac
exit 0'
stub pct 'echo "pct $*" >>"$S/calls"
case "$1" in
  status) [ -f "$S/exists-$2" ]; exit $? ;;
  create) touch "$S/exists-$2" ;;
  push) mkdir -p "$S/pushed"; cp "$3" "$S/pushed/$(basename "$4")" ;;
  exec)
    shift 3
    case "$*" in
      "hostname -I") echo "10.0.0.5 " ;;
      *install-plexamp-web.sh*) [ -f "$S/install-fails" ] && exit 1 ;;
    esac ;;
esac
exit 0'

reset() {
    rm -rf "$T/calls" "$T/pushed" "$T"/exists-* "$T/have-template" "$T/uid" "$T/install-fails"
    echo "pve-manager/8.2.4/faa83925 (running kernel: 6.8.12-1-pve)" >"$T/pveversion"
}

# run [VAR=value ...]: the script, without questions, against the stand-ins.
run() {
    env -i HOME="$T" PATH="$T/bin:/usr/bin:/bin" HOSTNAME=pve-node-1 YES=1 PW_INSTALL_SCRIPT="$ROOT/proxmox/install.sh" "$@" \
        bash "$SCRIPT" >"$T/out" 2>&1
}

calls() { cat "$T/calls" 2>/dev/null || true; }

# ---------- a container with settings ----------

reset
if run PLEX_SERVER_URL=http://192.168.1.10:32400 OLLAMA_URL=http://192.168.1.20:11434 OLLAMA_MODEL=llama3.1:8b; then
    pass "makes a container"
else
    fail "makes a container: $(tail -5 "$T/out")"
fi
create="$(calls | grep '^pct create' || true)"
case "$create" in
    "pct create 123 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --hostname plexamp-web --cores 1 --memory 512 --swap 512 --rootfs local-lvm:4 --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian --timezone host --tags plexamp-web --description plexamp-web: https://github.com/kamakazedan/plexamp-web")
        pass "an unprivileged Debian 13 container, with the next free ID, on local-lvm, with DHCP" ;;
    *) fail "the container: $create" ;;
esac
calls | grep -q '^pveam download local debian-13-standard_13.1-2_amd64.tar.zst$' && pass "downloads the newest Debian template" || fail "template download: $(calls | grep pveam)"
expected="$(printf '%s\n' '# plexamp-web settings, the same as the Docker image'"'"'s (see "Container' '# settings" in the README). Change them with: plexamp-web-settings' \
    'PLEX_SERVER_URL=http://192.168.1.10:32400' 'DISABLE_WEBSOCKETS=' 'OLLAMA_URL=http://192.168.1.20:11434' 'OLLAMA_MODEL=llama3.1:8b' \
    'OLLAMA_API_KEY=' 'OLLAMA_AUTH=plex' 'PLAY_TOGETHER=true' 'CASTING=true' 'MUSICBRAINZ=true' 'DEBUG=')"
[ "$(cat "$T/pushed/plexamp-web.env" 2>/dev/null)" = "$expected" ] && pass "writes the settings" || fail "settings: $(cat "$T/pushed/plexamp-web.env" 2>/dev/null)"
calls | grep -q -- '^pct push 123 .*/plexamp-web.env /etc/plexamp-web/plexamp-web.env --perms 600$' && pass "settings readable by root only" || fail "settings permissions: $(calls | grep push)"
cmp -s "$T/pushed/install-plexamp-web.sh" "$ROOT/proxmox/install.sh" && pass "copies in the installer" || fail "the installer wasn't copied in"
calls | grep -q '^pct exec 123 -- env LC_ALL=C.UTF-8 PW_REPO=kamakazedan/plexamp-web PW_REF=stable bash /root/install-plexamp-web.sh$' && pass "runs the installer, for the stable branch" || fail "installer run: $(calls | grep install)"
grep -q 'plexamp-web is ready: http://10.0.0.5/' "$T/out" && pass "says where to find it" || fail "address: $(tail -3 "$T/out")"

# ---------- a fixed address, another storage, a template already there ----------

reset
echo "debian-12-standard_12.7-1_amd64.tar.zst" >"$T/have-template"
run CTID=250 CT_HOSTNAME=music STORAGE=tank IP=192.168.1.50/24 GATEWAY=192.168.1.1 CORES=2 RAM_MB=1024 DISK_GB=8 || true
create="$(calls | grep '^pct create' || true)"
case "$create" in
    "pct create 250 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst --hostname music --cores 2 --memory 1024 --swap 512 --rootfs tank:8 --net0 name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1 "*)
        pass "a fixed address, other sizes and storage, with the template that's there" ;;
    *) fail "settings from the environment: $create $(tail -3 "$T/out")" ;;
esac
calls | grep -q '^pveam download' && fail "downloaded a template it had" || pass "no download when there's a template"

# ---------- asking (in a terminal) ----------

# Declining the defaults asks about each setting; Enter keeps a suggestion.
reset
if command -v script >/dev/null 2>&1; then
    printf 'n\n\nmusic\ntank\n2\n\n\n\n192.168.1.60/24\n192.168.1.1\nhttp://192.168.1.10:32400\n\n\n' |
        env -i HOME="$T" PATH="$T/bin:/usr/bin:/bin" TERM=dumb PW_INSTALL_SCRIPT="$ROOT/proxmox/install.sh" \
            script -qec "bash $(printf '%q' "$SCRIPT")" /dev/null >"$T/out" 2>&1 || true
    create="$(calls | grep '^pct create' || true)"
    case "$create" in
        "pct create 123 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --hostname music --cores 2 --memory 512 --swap 512 --rootfs tank:4 --net0 name=eth0,bridge=vmbr0,ip=192.168.1.60/24,gw=192.168.1.1 "*)
            pass "asks about each setting when the defaults are declined" ;;
        *) fail "asking: $create $(tail -5 "$T/out" | tr -d '\r')" ;;
    esac
    grep -qx 'PLEX_SERVER_URL=http://192.168.1.10:32400' "$T/pushed/plexamp-web.env" 2>/dev/null && pass "a Plex address given when asked reaches the settings" ||
        fail "asked settings: $(cat "$T/pushed/plexamp-web.env" 2>/dev/null)"
    reset
    printf '\n\n' | env -i HOME="$T" PATH="$T/bin:/usr/bin:/bin" TERM=dumb PW_INSTALL_SCRIPT="$ROOT/proxmox/install.sh" \
        script -qec "bash $(printf '%q' "$SCRIPT")" /dev/null >"$T/out" 2>&1 || true
    calls | grep -q '^pct create 123 .* --hostname plexamp-web --cores 1 --memory 512 --swap 512 --rootfs local-lvm:4 --net0 name=eth0,bridge=vmbr0,ip=dhcp ' &&
        pass "Enter twice makes it with the default settings" || fail "defaults in a terminal: $(calls | grep create) $(tail -5 "$T/out" | tr -d '\r')"
    reset
    printf '\nn\n' | env -i HOME="$T" PATH="$T/bin:/usr/bin:/bin" TERM=dumb PW_INSTALL_SCRIPT="$ROOT/proxmox/install.sh" \
        script -qec "bash $(printf '%q' "$SCRIPT")" /dev/null >"$T/out" 2>&1 || true
    if calls | grep -q '^pct create'; then fail "answering no to \"Make it?\" made a container"; else pass "answering no to \"Make it?\" makes nothing"; fi
else
    echo "SKIP asking: no script(1) here"
fi

# ---------- what it refuses ----------

# refuses NAME "the message it gives" VAR=value ...: stops before making
# anything, and says why.
refuses() {
    local name="$1" says="$2"
    shift 2
    reset
    if [ "$name" = "an ID that's taken" ]; then touch "$T/exists-123"; fi
    if [ "$name" = "to run without root" ]; then echo 1000 >"$T/uid"; fi
    if [ "$name" = "Proxmox VE 7" ]; then echo "pve-manager/7.4-3/9002ab8a (running kernel: 5.15.102-1-pve)" >"$T/pveversion"; fi
    if run "$@"; then
        fail "refuses $name: it went ahead"
    elif calls | grep -q '^pct create'; then
        fail "refuses $name: it made a container first"
    elif ! grep -qF -- "$says" "$T/out"; then
        fail "refuses $name: said $(tail -1 "$T/out")"
    else
        pass "refuses $name"
    fi
}
refuses "an address with shell characters" "The Plex server's address isn't right" 'PLEX_SERVER_URL=http://x"; rm -rf /tmp/x; echo "'
refuses "an address over two lines" "The Plex server's address isn't right" "PLEX_SERVER_URL=$(printf 'http://192.168.1.10:32400\nNODE_OPTIONS=--require=/tmp/x')"
refuses "an address with a password" "The Ollama address isn't right" 'OLLAMA_URL=http://user:secret@192.168.1.20:11434'
refuses "a model with odd characters" "The model isn't right" 'OLLAMA_URL=http://192.168.1.20:11434' 'OLLAMA_MODEL=llama;reboot'
refuses "a bad name" "The name isn't right" 'CT_HOSTNAME=Not_A_Name!'
refuses "a storage that can't hold containers" "nfs-backups can't hold containers" 'STORAGE=nfs-backups'
refuses "a fixed address without a gateway" "The gateway isn't right" 'IP=192.168.1.50/24'
refuses "an ID that's taken" "There's already a container or VM 123"
refuses "to run without root" "Run this as root"
refuses "Proxmox VE 7" "This needs Proxmox VE 8 or later"

# ---------- when the install fails ----------

reset
touch "$T/install-fails"
if run; then
    fail "an install that fails: it said it worked"
elif grep -q 'Container 123 was made, but plexamp-web was not installed. To remove it: pct stop 123; pct destroy 123' "$T/out"; then
    pass "an install that fails says how to remove the container"
else
    fail "an install that fails: $(tail -3 "$T/out")"
fi

# ---------- the installer ----------

# While the service starts, nginx answers its address with 502: the
# installer's checks of the container's own address must keep curl quiet
# (0.10.0 printed "curl: (22) ... 502" in the middle of the install).
if grep -nE 'curl -[A-Za-z]*S[A-Za-z]* [^|;]*127\.0\.0\.1' "$ROOT/proxmox/install.sh" >"$T/loud"; then
    fail "the installer's start-up checks print curl's errors: $(cat "$T/loud")"
else
    pass "the installer's start-up checks are quiet"
fi

[ "$FAILED" = 0 ] && echo "ALL PROXMOX SCRIPT TESTS PASSED"
exit "$FAILED"
