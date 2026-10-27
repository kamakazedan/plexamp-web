#!/usr/bin/env bash
# Installs plexamp-web on Debian 12 or 13, or updates it to the newest
# version: nginx and Node.js from Debian, the app from GitHub, and hls.js
# from npm (checked against the registry's checksum, as the Docker image's
# build does). It's what proxmox/plexamp-web.sh runs inside the container it
# makes, and what `update-plexamp-web` runs there later.
#
# The app comes from the repository's "stable" branch, which CI moves to
# each commit that passed every test (the commits the Docker image is built
# from), or from main if there's no such branch yet. PW_REF picks another.
#
# Settings live in /etc/plexamp-web/plexamp-web.env, with the same names as
# the Docker image's (PLEX_SERVER_URL, OLLAMA_URL and so on). To change
# them: plexamp-web-settings (it opens the file, then restarts the app).
#
# Every step in detail, with the tools' own output: PW_VERBOSE=1, or
# --verbose (update-plexamp-web --verbose passes it on).
#
# For tests: PW_SOURCE_DIR installs from a folder instead of GitHub, and
# PW_NO_SYSTEMD=1 skips systemd (in a container without it).
set -euo pipefail

REPO="${PW_REPO:-kamakazedan/plexamp-web}"
REF="${PW_REF:-stable}"
WANT_REF="$REF" # for updates (REF may fall back to main below)
BASE=/opt/plexamp-web
ENV_FILE=/etc/plexamp-web/plexamp-web.env

if [ -t 1 ]; then
    OK=$'\033[1;32m✔\033[0m' BAD=$'\033[1;31m✖\033[0m' DIM=$'\033[2m' RESET=$'\033[0m'
else
    OK='✔' BAD='✖' DIM='' RESET=''
fi
say() { printf '  %s %s\n' "$OK" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
fail() {
    printf '  %s %s\n' "$BAD" "$*" >&2
    exit 1
}

verbose=false
case "${PW_VERBOSE:-}" in 1 | true | yes) verbose=true ;; esac
for arg in "$@"; do
    case "$arg" in
        -v | --verbose) verbose=true ;;
        *) fail "Unknown option: $arg (the only one is --verbose)." ;;
    esac
done
# What's happening, in detail mode only.
detail() { if [ "$verbose" = true ]; then note "$*"; fi; }
# shown CMD...: runs CMD with its output shown, indented (detail mode).
shown() {
    local status=0
    "$@" 2>&1 | sed -u 's/^/      /' || status=$?
    return "$status"
}
# In detail mode, a command that fails says which line of this it was
# (otherwise the tool's own error is the last thing shown).
stopped() {
    printf '  %s Stopped at line %s of the installer: %s\n' "$BAD" "$1" "$(sed -n "$1p" "${BASH_SOURCE[0]}" 2>/dev/null | sed 's/^ *//')" >&2
}
if [ "$verbose" = true ]; then
    set -E
    trap 'stopped "$LINENO"' ERR
fi

[ "$(id -u)" = 0 ] || fail "Run this as root."
[ -r /etc/debian_version ] || fail "This installs on Debian (12 or 13)."
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "PW_REPO should look like owner/name."
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ ]] || fail "PW_REF should be a branch or tag name."

systemd=true
if [ "${PW_NO_SYSTEMD:-}" = 1 ] || [ ! -d /run/systemd/system ]; then systemd=false; fi
was="$(sed -n "s/^export const APP_INFO = .*version: '\([0-9.]*\)'.*/\1/p" "$BASE/html/js/plex.js" 2>/dev/null || true)"
detail "In detail: Debian $(cat /etc/debian_version), $REPO ($REF)$([ -n "$was" ] && printf ', %s installed now' "$was")$([ "$systemd" = true ] || printf ', without systemd')"

export DEBIAN_FRONTEND=noninteractive
detail "apt-get update"
if [ "$verbose" = true ]; then shown apt-get update; else apt-get update -qq; fi
detail "apt-get install nginx nodejs curl wget ca-certificates tar gzip"
if [ "$verbose" = true ]; then
    shown apt-get install -y --no-install-recommends nginx nodejs curl wget ca-certificates tar gzip
else
    apt-get install -y -qq --no-install-recommends nginx nodejs curl wget ca-certificates tar gzip >/dev/null
fi
say "Installed nginx $(nginx -v 2>&1 | sed -n 's#.*nginx/##p') and Node.js $(node --version) from Debian"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# size FILE: how big it is, to say so.
size() { numfmt --to=iec --suffix=B "$(wc -c <"$1")" 2>/dev/null || printf '%s bytes' "$(wc -c <"$1")"; }

if [ -n "${PW_SOURCE_DIR:-}" ]; then
    mkdir "$work/app"
    detail "Copying web, server, docker, proxmox and the Dockerfile from $PW_SOURCE_DIR"
    cp -r "$PW_SOURCE_DIR/web" "$PW_SOURCE_DIR/server" "$PW_SOURCE_DIR/docker" "$PW_SOURCE_DIR/proxmox" "$PW_SOURCE_DIR/Dockerfile" "$work/app/"
    say "Copied plexamp-web from $PW_SOURCE_DIR"
else
    # download URL FILE: its HTTP status (000: no answer, or it stopped partway).
    download() {
        local code
        code="$(curl -sSL -o "$2" -w '%{http_code}' "$1" 2>/dev/null)" || code=000
        if [ "$code" = 200 ]; then detail "$1: HTTP $code, $(size "$2")" >&2; else detail "$1: HTTP $code" >&2; fi
        printf '%s' "$code"
    }
    # The stable branch, or main until CI has made one: only when GitHub
    # says there's no stable branch, never because a download failed (that
    # would install something untested).
    code="$(download "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" "$work/app.tar.gz")"
    if [ "$code" = 404 ] && [ "$REF" = stable ]; then
        detail "There's no stable branch yet, so main instead"
        REF=main
        code="$(download "https://github.com/$REPO/archive/refs/heads/main.tar.gz" "$work/app.tar.gz")"
    elif [ "$code" = 404 ]; then
        detail "$REF isn't a branch: trying it as a tag or commit"
        code="$(download "https://github.com/$REPO/archive/$REF.tar.gz" "$work/app.tar.gz")"
    fi
    [ "$code" = 200 ] || fail "Couldn't download plexamp-web ($REPO, $REF) from GitHub (HTTP ${code:-000}). Nothing was changed."
    unset -f download
    mkdir "$work/app"
    detail "Unpacking it in $work/app"
    tar -xzf "$work/app.tar.gz" -C "$work/app" --strip-components=1
fi
for f in web/index.html web/js/plex.js server/index.js docker/40-plexamp-web.sh docker/nginx.conf proxmox/install.sh Dockerfile; do
    [ -f "$work/app/$f" ] || fail "The download is missing $f."
done
detail "It has what's needed (web/index.html, server/index.js, docker/nginx.conf and the rest)"
version="$(sed -n "s/^export const APP_INFO = .*version: '\([0-9.]*\)'.*/\1/p" "$work/app/web/js/plex.js")"
[ -n "${PW_SOURCE_DIR:-}" ] || say "Downloaded plexamp-web ${version:-?} ($REPO, $REF)"

# hls.js: the version the Docker image bundles, checked against the npm
# registry's own checksum for it.
hls="$(sed -n 's/^ARG HLS_JS_VERSION=\([0-9][0-9.]*\)$/\1/p' "$work/app/Dockerfile" | head -n 1)"
[ -n "$hls" ] || fail "Couldn't tell which hls.js version to use."
detail "hls.js $hls, the version the Dockerfile names: https://registry.npmjs.org/hls.js/$hls"
curl -fsSL "https://registry.npmjs.org/hls.js/$hls" -o "$work/hls.json" || fail "Couldn't reach the npm registry for hls.js."
curl -fsSL "https://registry.npmjs.org/hls.js/-/hls.js-$hls.tgz" -o "$work/hls.tgz" || fail "Couldn't download hls.js."
detail "https://registry.npmjs.org/hls.js/-/hls.js-$hls.tgz: $(size "$work/hls.tgz")"
checked="$(node -e '
    const { readFileSync } = require("fs");
    const { createHash } = require("crypto");
    const want = JSON.parse(readFileSync(process.argv[1], "utf8")).dist.integrity;
    const got = "sha512-" + createHash("sha512").update(readFileSync(process.argv[2])).digest("base64");
    if (!/^sha512-/.test(want) || want !== got) { console.error("hls.js does not match the npm registry checksum"); process.exit(1); }
    console.log(got);
' "$work/hls.json" "$work/hls.tgz")" || fail "hls.js didn't match its checksum, so it wasn't installed."
detail "Its checksum, as the registry gives it: $checked"
mkdir "$work/hls"
tar -xzf "$work/hls.tgz" -C "$work/hls"
say "Downloaded hls.js $hls (it matched the npm registry's checksum)"

mkdir -p "$BASE" /etc/plexamp-web
rm -rf "$BASE/app.new" "$BASE/html.new"
detail "Putting it in $BASE: the app in app/, what browsers load in html/ (with hls.js in html/vendor/)"
cp -r "$work/app" "$BASE/app.new"
cp -r "$work/app/web" "$BASE/html.new"
mkdir -p "$BASE/html.new/vendor"
cp "$work/hls/package/dist/hls.min.js" "$BASE/html.new/vendor/hls.min.js"
cp "$work/hls/package/LICENSE" "$BASE/html.new/vendor/hls.js-LICENSE.txt"
printf '%s\n' "$hls" >"$BASE/html.new/vendor/hls.js-VERSION.txt"
for d in app html; do
    rm -rf "$BASE/$d.old"
    if [ -d "$BASE/$d" ]; then mv "$BASE/$d" "$BASE/$d.old"; fi
    mv "$BASE/$d.new" "$BASE/$d"
done
rm -rf "$BASE/app.old" "$BASE/html.old"

# Settings: written once (proxmox/plexamp-web.sh may have put them here
# already), and kept as they are on an update.
if [ -f "$ENV_FILE" ]; then detail "Settings: $ENV_FILE, kept as they are"; else detail "Settings: $ENV_FILE, with the defaults"; fi
if [ ! -f "$ENV_FILE" ]; then
    cat >"$ENV_FILE" <<'ENV'
# plexamp-web settings, the same as the Docker image's (see
# docs/configuration.md). Change them with: plexamp-web-settings
PLEX_SERVER_URL=
DISABLE_WEBSOCKETS=
OLLAMA_URL=
OLLAMA_MODEL=
OLLAMA_API_KEY=
OLLAMA_AUTH=plex
PLAY_TOGETHER=true
CASTING=true
PLAYLIST_SHARING=true
# Each Plex account's settings kept by the player, so they follow it to every
# browser it signs in on (false: each browser keeps its own).
SYNC_SETTINGS=true
# MusicBrainz, to check the suggestions in AI playlists: https://musicbrainz.org
# (the public service) or your own mirror. Empty: no checks.
MUSICBRAINZ_URL=
# true: Search › From Spotify makes playlists from Spotify's download of your
# data, read in the browser (see docs/configuration.md).
SPOTIFY_FILE_IMPORT=
# true: Search › From Spotify makes a playlist from a Spotify playlist's link,
# read from Spotify's public page for it (see docs/configuration.md).
SPOTIFY_LINK_IMPORT=
DEBUG=
ENV
fi
chmod 600 "$ENV_FILE"

# nginx: the app's server, in place of Debian's default site.
detail "nginx: /etc/nginx/conf.d/default.conf from the app's docker/nginx.conf, in place of Debian's default site"
rm -f /etc/nginx/sites-enabled/default
sed -e "s#root /usr/share/nginx/html;#root $BASE/html;#" "$BASE/app/docker/nginx.conf" >/etc/nginx/conf.d/default.conf
for inc in pms-proxy ai-proxy api log; do touch "/etc/nginx/conf.d/$inc.inc"; done
if [ -n "$was" ] && [ "$was" != "${version:-}" ]; then
    say "Updated plexamp-web from $was to ${version:-?} in $BASE"
else
    say "Put plexamp-web ${version:-} in $BASE"
fi

# put_command PATH: what's read in, put in place as a command at PATH, by
# writing it next to it and renaming it there, never by changing the file
# that's there. update-plexamp-web is running while it's replaced (it's
# what runs this), and a shell reads its script as it goes: changed where it
# stood, it would carry on reading into the new one (as 0.16.0's update
# did, ending in a "Syntax error").
put_command() {
    local tmp
    rm -f "$1".??????
    tmp="$(mktemp "$1.XXXXXX")"
    cat >"$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$1"
}

# `update-plexamp-web`: the newest version, with the same settings. All of
# it in braces, so it's read to the end before any of it runs: the
# installer it runs puts a new one in its place.
put_command /usr/local/bin/update-plexamp-web <<UPDATE
#!/bin/sh
# Updates plexamp-web to the newest tested version; settings are kept.
#   update-plexamp-web [--verbose]
# --verbose (or PW_VERBOSE=1): every step in detail, with the tools' own output.
{
set -eu
verbose=""
case "\${PW_VERBOSE:-}" in 1 | true | yes) verbose=1 ;; esac
for arg in "\$@"; do
    case "\$arg" in
        -v | --verbose) verbose=1 ;;
        -h | --help)
            echo "Usage: update-plexamp-web [--verbose]"
            echo "Updates plexamp-web to the newest tested version ($REPO, $WANT_REF), keeping its settings."
            echo "  -v, --verbose   every step in detail, with the tools' own output (or PW_VERBOSE=1)"
            exit 0 ;;
        *) echo "update-plexamp-web: there's no option \$arg (see --help). Nothing was changed." >&2; exit 2 ;;
    esac
done
tmp="\$(mktemp)"
trap 'rm -f "\$tmp"' EXIT
# (Its HTTP status; 000 when it didn't all arrive.)
get() {
    url="https://raw.githubusercontent.com/$REPO/\$1/proxmox/install.sh"
    code="\$(curl -sSL -o "\$tmp" -w '%{http_code}' "\$url" 2>/dev/null)" || code=000
    if [ -n "\$verbose" ]; then echo "    The installer, \$url: HTTP \$code" >&2; fi
    echo "\$code"
}
code="\$(get $WANT_REF)"
# main only while there's no stable branch (not because a download failed).
if [ "\$code" = 404 ] && [ "$WANT_REF" = stable ]; then code="\$(get main)"; fi
[ "\$code" = 200 ] || { echo "Couldn't download the installer (HTTP \${code:-000}). Nothing was changed." >&2; exit 1; }
LC_ALL=C.UTF-8 PW_REPO="$REPO" PW_REF="$WANT_REF" PW_VERBOSE="\$verbose" bash "\$tmp"
exit
}
UPDATE
detail "Commands: update-plexamp-web and plexamp-web-settings, in /usr/local/bin (linked from /usr/bin)"

# `plexamp-web-settings`: opens the settings, then restarts the app with them.
put_command /usr/local/bin/plexamp-web-settings <<'SETTINGS'
#!/bin/sh
# Opens plexamp-web's settings in an editor, then restarts it with them.
set -eu
file=/etc/plexamp-web/plexamp-web.env
editor="${VISUAL:-${EDITOR:-}}"
if [ -z "$editor" ]; then
    for e in nano vim.tiny vi; do
        if command -v "$e" >/dev/null 2>&1; then editor="$e" && break; fi
    done
fi
[ -n "$editor" ] || { echo "No editor found: edit $file, then run: systemctl restart plexamp-web-config plexamp-web nginx" >&2; exit 1; }
before="$(cksum <"$file")"
"$editor" "$file"
if [ "$(cksum <"$file")" = "$before" ]; then
    echo "Nothing changed."
    exit 0
fi
if systemctl restart plexamp-web-config plexamp-web nginx; then
    echo "plexamp-web restarted with the new settings."
else
    echo "plexamp-web didn't start with these settings. What went wrong:" >&2
    journalctl -u plexamp-web-config -n 5 --no-pager -o cat >&2 || true
    exit 1
fi
SETTINGS

# Both are linked from /usr/bin too: `pct exec <ID> -- update-plexamp-web`
# runs it with Proxmox's own search path (PATH=/sbin:/bin:/usr/sbin:/usr/bin,
# which pct sets for itself), which leaves out /usr/local/bin.
for cmd in update-plexamp-web plexamp-web-settings; do
    ln -sfn "/usr/local/bin/$cmd" "/usr/bin/$cmd"
done

# The start-up script the Docker image runs writes nginx's settings and the
# app's (plexamp-web-config), then the service starts, then nginx. The
# service runs as www-data from the start: Node.js on Debian 13 can't give
# up root itself (it refuses to while io_uring may be in use, CVE-2024-22017).
detail "systemd: plexamp-web-config.service (the settings, for nginx and the app), plexamp-web.service (the service, as www-data), and nginx after them"
mkdir -p /etc/systemd/system/nginx.service.d
cat >/etc/systemd/system/plexamp-web-config.service <<UNIT
[Unit]
Description=plexamp-web: its settings, for nginx and the app
Before=nginx.service plexamp-web.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=$ENV_FILE
Environment=HTML_DIR=$BASE/html CONF_DIR=/etc/nginx/conf.d SERVICE_DIR=$BASE/app/server RUN_DIR=/run/plexamp-web DATA_DIR=/var/lib/plexamp-web SERVICE_USER=www-data SERVICE_START=false NGINX_ACCESS_LOG=syslog:server=unix:/dev/log,tag=nginx,nohostname
ExecStart=/bin/sh $BASE/app/docker/40-plexamp-web.sh

[Install]
WantedBy=multi-user.target
UNIT
cat >/etc/systemd/system/plexamp-web.service <<UNIT
[Unit]
Description=plexamp-web service (Play Together, Play on, your devices, the shared AI model)
Requires=plexamp-web-config.service
After=plexamp-web-config.service network-online.target

[Service]
User=www-data
Group=www-data
ExecStart=/usr/bin/node $BASE/app/server/index.js /run/plexamp-web/service.json
Restart=always
RestartSec=2
# What it makes is its own alone, and it can never gain privileges or
# capabilities (only what works in an unprivileged container).
NoNewPrivileges=yes
CapabilityBoundingSet=
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
cat >/etc/systemd/system/nginx.service.d/plexamp-web.conf <<UNIT
[Unit]
Requires=plexamp-web-config.service
After=plexamp-web-config.service
UNIT

if [ "$systemd" = true ]; then
    detail "systemctl daemon-reload"
    systemctl daemon-reload
    detail "systemctl enable plexamp-web-config plexamp-web nginx"
    systemctl enable --quiet plexamp-web-config.service plexamp-web.service nginx.service
    # All at once, so each restarts once (restarting the settings alone
    # restarts the service with them, and it went again after).
    detail "systemctl restart plexamp-web-config plexamp-web nginx"
    since="$(date +%s)"
    systemctl restart plexamp-web-config.service plexamp-web.service nginx.service
    # Until the service is up, nginx answers its address with an error
    # (502), so the checks are quiet, and only the outcome is told.
    detail "Waiting for it to answer at http://127.0.0.1/api/health (up to 15 seconds)"
    for _ in $(seq 1 30); do
        curl -fs -o /dev/null http://127.0.0.1/api/health && break
        sleep 0.5
    done
    if [ "$verbose" = true ]; then
        for unit in plexamp-web-config plexamp-web nginx; do
            detail "$unit: $(systemctl is-active "$unit" 2>/dev/null || true)"
        done
        detail "What they logged as they started (journalctl -u plexamp-web-config -u plexamp-web -u nginx):"
        shown journalctl --no-pager -o cat -u plexamp-web-config -u plexamp-web -u nginx --since "@$since" || true
    fi
    curl -fs -o /dev/null http://127.0.0.1/ || fail "plexamp-web didn't start. See: journalctl -u plexamp-web-config -u plexamp-web -u nginx"
    curl -fs -o /dev/null http://127.0.0.1/api/health || note "Its service (Play Together, Play on, your devices) isn't answering yet: journalctl -u plexamp-web"
    detail "It answered after $(($(date +%s) - since)) s"
    say "plexamp-web ${version:-} is running"
else
    say "Installed. systemd isn't running here, so start it yourself."
fi
