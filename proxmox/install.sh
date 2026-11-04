#!/usr/bin/env bash
# Installs plexamp-web on Debian 12 or 13, or updates it to the newest
# version: nginx and Node.js from Debian (with Debian's other packages
# upgraded, for their security fixes), the app from GitHub, and hls.js from
# npm (checked against the checksum the Dockerfile keeps for it, as the
# Docker image's build does). It's what proxmox/plexamp-web.sh runs inside
# the container it makes, and what `update-plexamp-web` runs there later.
#
# The app comes from the repository's "stable" branch, which CI moves to
# each commit that passed every test (the commits the Docker image is built
# from). PW_REF picks another branch, a tag or a commit. Run as it's
# downloaded, this finds which commit that is, downloads it, and runs that
# commit's own installer on it, so the installer and the app are always the
# same commit.
#
# An update that doesn't start (a setting the new version won't take, say)
# puts the version from before back, and says what was wrong.
#
# Settings live in /etc/plexamp-web/plexamp-web.env, with the same names as
# the Docker image's (PLEX_SERVER_URL, OLLAMA_URL and so on). To change
# them: plexamp-web-settings (it opens the file, then restarts the app).
#
# Every step in detail, with the tools' own output: PW_VERBOSE=1, or
# --verbose (update-plexamp-web --verbose passes it on).
#
# For tests: PW_SOURCE_DIR installs from a folder instead of GitHub (as the
# installer it downloaded runs), and PW_NO_SYSTEMD=1 skips systemd (in a
# container without it: the settings are still checked, as they are when
# the app starts).
set -euo pipefail

REPO="${PW_REPO:-kamakazedan/plexamp-web}"
REF="${PW_REF:-stable}"
BASE=/opt/plexamp-web
ENV_FILE=/etc/plexamp-web/plexamp-web.env

if [ -t 1 ]; then
    OK=$'\033[1;32m✔\033[0m' BAD=$'\033[1;31m✖\033[0m' DIM=$'\033[2m' RESET=$'\033[0m'
else
    OK='✔' BAD='✖' DIM='' RESET=''
fi
say() { printf '  %s %s\n' "$OK" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
bad() { printf '  %s %s\n' "$BAD" "$*" >&2; }
fail() {
    bad "$*"
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
# shellcheck disable=SC2329 # (the ERR trap below runs it)
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
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ ]] || fail "PW_REF should be a branch or tag name, or a commit."

# One install or update at a time (the installer it downloads, below, runs
# under this one's lock).
if [ -z "${PW_LOCK_HELD:-}" ] && command -v flock >/dev/null 2>&1; then
    mkdir -p /run/lock
    exec 9>/run/lock/plexamp-web-install.lock
    flock -n 9 || fail "Another install or update of plexamp-web is running here: wait for it to finish, then try again."
    export PW_LOCK_HELD=1
fi

export DEBIAN_FRONTEND=noninteractive
# (apt waits a while for another apt, as unattended upgrades may be running;
# and the lock above isn't handed on to anything it starts: 9>&-.)
apt_wait=(-o DPkg::Lock::Timeout=120)

# get URL FILE [curl options]: its HTTP status (000: no answer, or it
# stopped partway).
get() {
    local code url="$1" out="$2"
    shift 2
    code="$(curl -sSL -o "$out" -w '%{http_code}' "$@" "$url" 2>/dev/null)" || code=000
    detail "$url: HTTP $code" >&2
    printf '%s' "$code"
}

# ---------- from GitHub: one commit, and that commit's own installer ----------

if [ -z "${PW_SOURCE_DIR:-}" ]; then
    detail "In detail: Debian $(cat /etc/debian_version), $REPO ($REF): finding which commit that is, to install it with its own installer"
    if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1 || ! command -v gzip >/dev/null 2>&1; then
        detail "apt-get install curl ca-certificates tar gzip, to download it with"
        { apt-get update -qq "${apt_wait[@]}" 9>&- && apt-get install -y -qq --no-install-recommends "${apt_wait[@]}" curl ca-certificates tar gzip >/dev/null 9>&-; } || fail "Couldn't install curl to download plexamp-web with. Nothing of plexamp-web was changed."
    fi
    download_dir="$(mktemp -d)"
    trap 'rm -rf "$download_dir"' EXIT
    if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
        commit="$REF"
    else
        code="$(get "https://api.github.com/repos/$REPO/commits/$REF" "$download_dir/commit" -H 'Accept: application/vnd.github.sha')"
        commit="$(tr -d '\r\n' <"$download_dir/commit" 2>/dev/null || true)"
        case "$code" in
            200) [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "GitHub didn't say which commit $REF is ($REPO). Nothing was changed." ;;
            404 | 422)
                if [ "$REF" = stable ]; then fail "$REPO has no stable branch yet: CI makes it once a commit on main has passed every test. Nothing was changed."; fi
                fail "$REPO has no branch, tag or commit $REF on GitHub. Nothing was changed."
                ;;
            403 | 429) fail "GitHub's had too many requests from this address to say which commit $REF is (HTTP $code): try again in an hour. Nothing was changed." ;;
            *) fail "Couldn't ask GitHub which commit $REF is ($REPO: HTTP $code). Nothing was changed." ;;
        esac
    fi
    detail "$REF is commit $commit"
    code="$(get "https://github.com/$REPO/archive/$commit.tar.gz" "$download_dir/app.tar.gz")"
    [ "$code" = 200 ] || fail "Couldn't download plexamp-web ($REPO, $REF at ${commit:0:7}) from GitHub (HTTP $code). Nothing was changed."
    mkdir "$download_dir/app"
    tar -xzf "$download_dir/app.tar.gz" -C "$download_dir/app" --strip-components=1 || fail "The download of $REPO at ${commit:0:7} didn't unpack. Nothing was changed."
    [ -f "$download_dir/app/proxmox/install.sh" ] || fail "The download of $REPO at ${commit:0:7} has no installer (proxmox/install.sh). Nothing was changed."
    detail "Running that commit's own installer, on what it downloaded"
    status=0
    PW_SOURCE_DIR="$download_dir/app" PW_COMMIT="$commit" PW_REF="$REF" PW_REPO="$REPO" PW_VERBOSE="$([ "$verbose" = true ] && echo 1 || true)" \
        bash "$download_dir/app/proxmox/install.sh" || status=$?
    exit "$status"
fi

# ---------- installing (from PW_SOURCE_DIR) ----------

systemd=true
if [ "${PW_NO_SYSTEMD:-}" = 1 ] || [ ! -d /run/systemd/system ]; then systemd=false; fi
was="$(sed -n "s/^export const APP_INFO = .*version: '\([0-9.]*\)'.*/\1/p" "$BASE/html/js/plex.js" 2>/dev/null || true)"
detail "In detail: Debian $(cat /etc/debian_version), $REPO ($REF$([ -n "${PW_COMMIT:-}" ] && printf ' at %s' "${PW_COMMIT:0:7}"))$([ -n "$was" ] && printf ', %s installed now' "$was")$([ "$systemd" = true ] || printf ', without systemd')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Debian's own: nginx and Node.js, and every package's security fixes
# (keeping config files as they are).
keep_config=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
detail "apt-get update"
if [ "$verbose" = true ]; then shown apt-get update "${apt_wait[@]}" 9>&-; else apt-get update -qq "${apt_wait[@]}" 9>&-; fi
detail "apt-get install nginx nodejs curl wget ca-certificates tar gzip"
if [ "$verbose" = true ]; then
    shown apt-get install -y --no-install-recommends "${apt_wait[@]}" "${keep_config[@]}" nginx nodejs curl wget ca-certificates tar gzip 9>&-
else
    apt-get install -y -qq --no-install-recommends "${apt_wait[@]}" "${keep_config[@]}" nginx nodejs curl wget ca-certificates tar gzip >/dev/null 9>&-
fi
say "Installed nginx $(nginx -v 2>&1 | sed -n 's#.*nginx/##p') and Node.js $(node --version) from Debian"
detail "apt-get upgrade, for the security fixes of Debian's other packages (config files kept as they are)"
LC_ALL=C.UTF-8 apt-get upgrade -y -q "${apt_wait[@]}" "${keep_config[@]}" >"$work/upgrade.log" 2>&1 9>&- || { cat "$work/upgrade.log" >&2; fail "Debian's packages couldn't be upgraded (apt-get upgrade). Nothing of plexamp-web was changed."; }
if [ "$verbose" = true ]; then sed 's/^/      /' "$work/upgrade.log"; fi
upgraded="$(sed -n 's/^\([0-9][0-9]*\) upgraded,.*/\1/p' "$work/upgrade.log" | tail -n 1)"
case "${upgraded:-0}" in
    0) say "Debian's packages are up to date" ;;
    1) say "Upgraded 1 of Debian's packages, for its security fixes" ;;
    *) say "Upgraded $upgraded of Debian's packages, for their security fixes" ;;
esac

# size FILE: how big it is, to say so.
size() { numfmt --to=iec --suffix=B "$(wc -c <"$1")" 2>/dev/null || printf '%s bytes' "$(wc -c <"$1")"; }

mkdir "$work/app"
detail "Copying web, server, docker, proxmox and the Dockerfile from $PW_SOURCE_DIR"
cp -r "$PW_SOURCE_DIR/web" "$PW_SOURCE_DIR/server" "$PW_SOURCE_DIR/docker" "$PW_SOURCE_DIR/proxmox" "$PW_SOURCE_DIR/Dockerfile" "$work/app/"
for f in web/index.html web/js/plex.js server/index.js docker/40-plexamp-web.sh docker/nginx.conf proxmox/install.sh Dockerfile; do
    [ -f "$work/app/$f" ] || fail "The download is missing $f."
done
detail "It has what's needed (web/index.html, server/index.js, docker/nginx.conf and the rest)"
version="$(sed -n "s/^export const APP_INFO = .*version: '\([0-9.]*\)'.*/\1/p" "$work/app/web/js/plex.js")"
if [ -n "${PW_COMMIT:-}" ]; then
    say "Downloaded plexamp-web ${version:-?} ($REPO, $REF at ${PW_COMMIT:0:7})"
else
    say "Copied plexamp-web ${version:-?} from $PW_SOURCE_DIR"
fi

# hls.js: the version the Docker image bundles, checked against the checksum
# the Dockerfile keeps for it (the npm registry's for that version), so the
# registry alone can't change it.
hls="$(sed -n 's/^ARG HLS_JS_VERSION=\([0-9][0-9.]*\)$/\1/p' "$work/app/Dockerfile" | head -n 1)"
hls_integrity="$(sed -n 's/^ARG HLS_JS_INTEGRITY=\(sha512-[A-Za-z0-9+/=]*\)$/\1/p' "$work/app/Dockerfile" | head -n 1)"
if [ -z "$hls" ] || [ -z "$hls_integrity" ]; then fail "Couldn't tell which hls.js to use, and its checksum (the Dockerfile's HLS_JS_VERSION and HLS_JS_INTEGRITY)."; fi
detail "hls.js $hls, the version the Dockerfile names"
curl -fsSL "https://registry.npmjs.org/hls.js/-/hls.js-$hls.tgz" -o "$work/hls.tgz" || fail "Couldn't download hls.js."
detail "https://registry.npmjs.org/hls.js/-/hls.js-$hls.tgz: $(size "$work/hls.tgz")"
checked="$(node -e '
    const { readFileSync } = require("fs");
    const { createHash } = require("crypto");
    const got = "sha512-" + createHash("sha512").update(readFileSync(process.argv[1])).digest("base64");
    if (got !== process.argv[2]) { console.error("hls.js is " + got + ", not the " + process.argv[2] + " the Dockerfile has"); process.exit(1); }
    console.log(got);
' "$work/hls.tgz" "$hls_integrity")" || fail "hls.js didn't match its checksum, so it wasn't installed."
detail "Its checksum, the Dockerfile's: $checked"
mkdir "$work/hls"
tar -xzf "$work/hls.tgz" -C "$work/hls"
say "Downloaded hls.js $hls (it matched its checksum)"

# What's there now, to put back if this version doesn't start: the app
# and what browsers load (moved aside below), the settings, nginx's site,
# the systemd units and the two commands.
had=false
before="$work/before"
mkdir "$before"
if [ -d "$BASE/app" ] && [ -d "$BASE/html" ]; then
    had=true
    for f in "$ENV_FILE" /etc/nginx/conf.d/default.conf /etc/systemd/system/plexamp-web-config.service /etc/systemd/system/plexamp-web.service \
        /etc/systemd/system/nginx.service.d/plexamp-web.conf /usr/local/bin/update-plexamp-web /usr/local/bin/plexamp-web-settings; do
        if [ -f "$f" ]; then
            mkdir -p "$before$(dirname "$f")"
            cp -p "$f" "$before$f"
        fi
    done
    detail "Kept what's there now ($was), to put back if this version doesn't start"
fi

mkdir -p "$BASE" /etc/plexamp-web
rm -rf "$BASE/app.new" "$BASE/html.new"
detail "Putting it in $BASE: the app in app/, what browsers load in html/ (with hls.js in html/vendor/)"
cp -r "$work/app" "$BASE/app.new"
cp -r "$work/app/web" "$BASE/html.new"
mkdir -p "$BASE/html.new/vendor"
cp "$work/hls/package/dist/hls.min.js" "$BASE/html.new/vendor/hls.min.js"
cp "$work/hls/package/LICENSE" "$BASE/html.new/vendor/hls.js-LICENSE.txt"
printf '%s\n' "$hls" >"$BASE/html.new/vendor/hls.js-VERSION.txt"
# (The ones from before stay beside them, as .old, till this one has started.)
for d in app html; do
    rm -rf "$BASE/$d.old"
    if [ -d "$BASE/$d" ]; then mv "$BASE/$d" "$BASE/$d.old"; fi
    mv "$BASE/$d.new" "$BASE/$d"
done

# Settings: written once (proxmox/plexamp-web.sh may have put them here
# already), and kept as they are on an update.
if [ -f "$ENV_FILE" ]; then detail "Settings: $ENV_FILE, kept as they are"; else detail "Settings: $ENV_FILE, with the defaults"; fi
if [ ! -f "$ENV_FILE" ]; then
    cat >"$ENV_FILE" <<'ENV'
# plexamp-web settings, the same as the Docker image's (see
# docs/configuration.md). Change them with: plexamp-web-settings
PLEX_SERVER_URL=
# Live updates: auto (WebSockets, or where they don't get through, an event
# stream or polling), on (WebSockets only) or off (never WebSockets).
WEBSOCKETS=auto
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
# When someone imports a playlist (or an AI playlist suggests music) your Plex
# server doesn't have all of, what's missing is synced into the server owner's
# Missing tracks, so they can see what's missing from their server; each
# account's follows it to every browser too (false: each browser keeps its own).
SYNC_MISSING_TRACKS=true
# MusicBrainz, to check the suggestions in AI playlists: https://musicbrainz.org
# (the public service) or your own mirror. Empty: no checks.
MUSICBRAINZ_URL=
# true: the MusicBrainz features, with MUSICBRAINZ_URL (missing albums on
# artist pages, original release years, artists' other names, MusicBrainz's
# kind for albums Plex hasn't typed for Skip live tracks and demos: see
# docs/features.md). Nothing else needs them. They look your whole library
# up, so a mirror of your own is best.
MUSICBRAINZ_ADVANCED=
# false: no playlists from Spotify's download of your data in Search › From
# Spotify (read in the browser: see docs/configuration.md). Empty: they're on.
SPOTIFY_FILE_IMPORT=
# true: Search › From Spotify makes a playlist from a Spotify playlist's link,
# read from Spotify's public page for it (see docs/configuration.md).
SPOTIFY_LINK_IMPORT=
# Offline mode, with PLEX_SERVER_URL: while plex.tv isn't answering, this
# player can be signed in to with this password, as your Plex server lets it
# in without signing in, which is as you, its owner (see
# docs/configuration.md): 12 to 200 letters, digits and . _ ~ + / = : , @ -
# (openssl rand -base64 24 makes one). Empty: no offline mode.
OFFLINE_PWD=
# Where the offline password can be used from: private (your own networks),
# any, or addresses and networks (192.168.1.0/24, say), separated by commas.
OFFLINE_NETWORKS=private
DEBUG=
ENV
fi
# Settings renamed since they were written: their names now, with their
# values as they were (and 0.30.0's words about them, where they're as it
# wrote them). The start-up script stops at the old names (see
# docker/40-plexamp-web.sh), so an update mustn't leave them.
renames=()
for pair in OFFLINE_KEY:OFFLINE_PWD OFFLINE_FROM:OFFLINE_NETWORKS; do
    old="${pair%%:*}" new="${pair#*:}"
    # (As systemd reads the file: spaces before a name don't count. And not
    # where the new name's there too: the start-up script then says which
    # to keep.)
    if grep -Eq "^[[:space:]]*$old=" "$ENV_FILE" && ! grep -Eq "^[[:space:]]*$new=" "$ENV_FILE"; then
        renames+=(-e "s/^([[:space:]]*)$old=/\\1$new=/")
    fi
done
if [ "${#renames[@]}" -gt 0 ]; then
    # (sed -i writes a new file beside it, with its owner and permissions,
    # and only then puts it in its place: never a file half written. Where
    # the file's a link to another, that other.)
    sed -E -i --follow-symlinks "${renames[@]}" \
        -e 's/^# player can be signed in to with this key, as your Plex server lets it in$/# player can be signed in to with this password, as your Plex server lets it in/' \
        -e 's/^# Where the offline key can be used from: private \(your own networks\), any,$/# Where the offline password can be used from: private (your own networks), any,/' \
        "$ENV_FILE"
    say "Settings: OFFLINE_KEY and OFFLINE_FROM are called OFFLINE_PWD and OFFLINE_NETWORKS now, so they've been renamed, keeping their values"
fi
chmod 600 "$ENV_FILE"

# nginx: the app's server, in place of Debian's default site.
detail "nginx: /etc/nginx/conf.d/default.conf from the app's docker/nginx.conf, in place of Debian's default site"
rm -f /etc/nginx/sites-enabled/default
sed -e "s#root /usr/share/nginx/html;#root $BASE/html;#" "$BASE/app/docker/nginx.conf" >/etc/nginx/conf.d/default.conf
for inc in pms-proxy pms-probe ai-proxy api log; do touch "/etc/nginx/conf.d/$inc.inc"; done
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
# installer it runs puts a new one in its place. (The installer it
# downloads finds which commit the branch is, and installs that commit with
# that commit's own installer.)
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
            echo "Updates plexamp-web to the newest tested version ($REPO, $REF), keeping its settings."
            echo "  -v, --verbose   every step in detail, with the tools' own output (or PW_VERBOSE=1)"
            exit 0 ;;
        *) echo "update-plexamp-web: there's no option \$arg (see --help). Nothing was changed." >&2; exit 2 ;;
    esac
done
tmp="\$(mktemp)"
trap 'rm -f "\$tmp"' EXIT
url="https://raw.githubusercontent.com/$REPO/$REF/proxmox/install.sh"
# (Its HTTP status; 000 when it didn't all arrive.)
code="\$(curl -sSL -o "\$tmp" -w '%{http_code}' "\$url" 2>/dev/null)" || code=000
if [ -n "\$verbose" ]; then echo "    The installer, \$url: HTTP \$code" >&2; fi
[ "\$code" = 200 ] || { echo "Couldn't download the installer (HTTP \${code:-000}). Nothing was changed." >&2; exit 1; }
LC_ALL=C.UTF-8 PW_REPO="$REPO" PW_REF="$REF" PW_VERBOSE="\$verbose" bash "\$tmp"
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
# (Wants: after the network's up only means something where it's asked
# for.)
cat >/etc/systemd/system/plexamp-web.service <<UNIT
[Unit]
Description=plexamp-web service (Play Together, Play on, your devices, the shared AI model)
Requires=plexamp-web-config.service
Wants=network-online.target
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
# (nginx makes a socket for the service's requests to the Plex server as it
# starts: one left by an nginx that stopped short would keep it from
# starting again.)
cat >/etc/systemd/system/nginx.service.d/plexamp-web.conf <<UNIT
[Unit]
Requires=plexamp-web-config.service
After=plexamp-web-config.service

[Service]
ExecStartPre=-/bin/rm -f /run/plexamp-web/pms/plex.sock
UNIT

# check_settings: the start-up script, as plexamp-web-config runs it (the
# settings, and the unit's own environment), for where systemd isn't: what
# it said in $work/check.log.
check_settings() {
    local vars
    vars="$(sed -n 's/^Environment=//p' /etc/systemd/system/plexamp-web-config.service)"
    # shellcheck disable=SC2016,SC2086 # (the script's own $1 and $@; the unit's settings, one word each)
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C.UTF-8 bash -c 'set -a; . "$1"; set +a; shift; exec env "$@" /bin/sh "'"$BASE"'/app/docker/40-plexamp-web.sh"' \
        check "$ENV_FILE" $vars >"$work/check.log" 2>&1 9>&-
}

# start: restarts plexamp-web with what's in place, and says whether it's
# up: its settings taken, the app answering at http://127.0.0.1/ and its
# service at /api/health. Without systemd, its settings are checked, as
# they would be. What went wrong, if anything, is in $work/why.
start() {
    : >"$work/why"
    if [ "$systemd" != true ]; then
        detail "Checking the settings, as plexamp-web-config would (systemd isn't running here)"
        check_settings && return 0
        grep '^plexamp-web: ' "$work/check.log" | tail -n 4 >"$work/why" || true
        [ -s "$work/why" ] || tail -n 4 "$work/check.log" >"$work/why"
        return 1
    fi
    local since up=false
    since="$(date +%s)"
    detail "systemctl daemon-reload"
    systemctl daemon-reload
    detail "systemctl enable plexamp-web-config plexamp-web nginx"
    systemctl enable --quiet plexamp-web-config.service plexamp-web.service nginx.service
    # All at once, so each restarts once (restarting the settings alone
    # restarts the service with them, and it went again after).
    detail "systemctl restart plexamp-web-config plexamp-web nginx"
    if systemctl restart plexamp-web-config.service plexamp-web.service nginx.service 2>/dev/null; then
        # Until the service is up, nginx answers its address with an error
        # (502), so the checks are quiet, and only the outcome is told.
        detail "Waiting for it to answer at http://127.0.0.1/api/health (up to 30 seconds)"
        for _ in $(seq 1 60); do
            curl -fs -o /dev/null http://127.0.0.1/api/health && break
            sleep 0.5
        done
        if curl -fs -o /dev/null http://127.0.0.1/ && curl -fs -o /dev/null http://127.0.0.1/api/health; then up=true; fi
    fi
    if [ "$verbose" = true ]; then
        for unit in plexamp-web-config plexamp-web nginx; do
            detail "$unit: $(systemctl is-active "$unit" 2>/dev/null || true)"
        done
        detail "What they logged as they started (journalctl -u plexamp-web-config -u plexamp-web -u nginx):"
        shown journalctl --no-pager -o cat -u plexamp-web-config -u plexamp-web -u nginx --since "@$since" || true
    fi
    if [ "$up" = true ]; then
        detail "It answered after $(($(date +%s) - since)) s"
        return 0
    fi
    # What the start-up script said (a setting it won't take, say), or else
    # the last of what they all logged.
    journalctl --no-pager -o cat -u plexamp-web-config --since "@$since" 2>/dev/null | grep '^plexamp-web: ' | tail -n 4 >"$work/why" || true
    [ -s "$work/why" ] || journalctl --no-pager -o cat -u plexamp-web-config -u plexamp-web -u nginx --since "@$since" 2>/dev/null | tail -n 4 >"$work/why" || true
    return 1
}

# put_back: the version from before, as it was, in place of this one.
put_back() {
    local f
    for d in app html; do
        rm -rf "${BASE:?}/$d"
        mv "$BASE/$d.old" "$BASE/$d"
    done
    (cd "$before" && find . -type f) | while read -r f; do
        f="${f#.}"
        cp -p "$before$f" "$f.restore"
        mv -f "$f.restore" "$f"
    done
}

if start; then
    rm -rf "$BASE/app.old" "$BASE/html.old"
    if [ "$systemd" = true ]; then
        say "plexamp-web ${version:-} is running"
    else
        say "Installed (its settings check out). systemd isn't running here, so start it yourself."
    fi
    exit 0
fi
bad "plexamp-web ${version:-} didn't start$([ "$systemd" = true ] || printf ' with these settings'). What it said:"
sed 's/^/      /' "$work/why" >&2
if [ "$had" != true ]; then
    fail "Change what it says (plexamp-web-settings, or $ENV_FILE), then run this again. See also: journalctl -u plexamp-web-config -u plexamp-web -u nginx"
fi
was="${was:-the version from before}"
detail "Putting $was back, as it was"
put_back
if start; then
    bad "So plexamp-web $was is back, as it was. Where what it said is about a setting, change that (plexamp-web-settings), then update again."
else
    bad "plexamp-web $was, put back as it was, didn't start either. What it said:"
    sed 's/^/      /' "$work/why" >&2
    bad "See: journalctl -u plexamp-web-config -u plexamp-web -u nginx"
fi
exit 1
