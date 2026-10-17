#!/usr/bin/env bash
# Installs plexamp-web on Debian 12 or 13, or updates it to the newest
# version: nginx and Node.js from Debian, the app from GitHub, and hls.js
# from npm (checked against the registry's checksum, as the Docker image's
# build does). It's what proxmox/plexamp-web.sh runs inside the container it
# makes, and what `update-plexamp-web` runs there later.
#
# Settings live in /etc/plexamp-web/plexamp-web.env, with the same names as
# the Docker image's (PLEX_SERVER_URL, OLLAMA_URL and so on). After changing
# them: systemctl restart plexamp-web-config nginx plexamp-web
#
# For tests: PW_SOURCE_DIR installs from a folder instead of GitHub, and
# PW_NO_SYSTEMD=1 skips systemd (in a container without it).
set -euo pipefail

REPO="${PW_REPO:-kamakazedan/plexamp-web}"
REF="${PW_REF:-main}"
BASE=/opt/plexamp-web
ENV_FILE=/etc/plexamp-web/plexamp-web.env

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() {
    printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
    exit 1
}

[ "$(id -u)" = 0 ] || fail "Run this as root."
[ -r /etc/debian_version ] || fail "This installs on Debian (12 or 13)."
printf '%s\n' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fail "PW_REPO should look like owner/name."
printf '%s\n' "$REF" | grep -Eq '^[A-Za-z0-9_./-]+$' || fail "PW_REF should be a branch or tag name."

systemd=true
if [ "${PW_NO_SYSTEMD:-}" = 1 ] || [ ! -d /run/systemd/system ]; then systemd=false; fi

say "Installing nginx and Node.js from Debian"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends nginx nodejs curl wget ca-certificates tar gzip >/dev/null

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -n "${PW_SOURCE_DIR:-}" ]; then
    say "Copying plexamp-web from $PW_SOURCE_DIR"
    mkdir "$work/app"
    cp -r "$PW_SOURCE_DIR/web" "$PW_SOURCE_DIR/server" "$PW_SOURCE_DIR/docker" "$PW_SOURCE_DIR/proxmox" "$PW_SOURCE_DIR/Dockerfile" "$work/app/"
else
    say "Downloading plexamp-web ($REPO, $REF)"
    curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" -o "$work/app.tar.gz"
    mkdir "$work/app"
    tar -xzf "$work/app.tar.gz" -C "$work/app" --strip-components=1
fi
for f in web/index.html server/index.js docker/40-plexamp-web.sh docker/nginx.conf proxmox/install.sh Dockerfile; do
    [ -f "$work/app/$f" ] || fail "The download is missing $f."
done

# hls.js: the version the Docker image bundles, checked against the npm
# registry's own checksum for it.
hls="$(sed -n 's/^ARG HLS_JS_VERSION=\([0-9][0-9.]*\)$/\1/p' "$work/app/Dockerfile" | head -n 1)"
[ -n "$hls" ] || fail "Couldn't tell which hls.js version to use."
say "Downloading hls.js $hls"
curl -fsSL "https://registry.npmjs.org/hls.js/$hls" -o "$work/hls.json"
curl -fsSL "https://registry.npmjs.org/hls.js/-/hls.js-$hls.tgz" -o "$work/hls.tgz"
node -e '
    const { readFileSync } = require("fs");
    const { createHash } = require("crypto");
    const want = JSON.parse(readFileSync(process.argv[1], "utf8")).dist.integrity;
    const got = "sha512-" + createHash("sha512").update(readFileSync(process.argv[2])).digest("base64");
    if (!/^sha512-/.test(want) || want !== got) { console.error("hls.js does not match the npm registry checksum"); process.exit(1); }
' "$work/hls.json" "$work/hls.tgz" || fail "hls.js didn't match its checksum, so it wasn't installed."
mkdir "$work/hls"
tar -xzf "$work/hls.tgz" -C "$work/hls"

say "Putting the files in place"
mkdir -p "$BASE" /etc/plexamp-web
rm -rf "$BASE/app.new" "$BASE/html.new"
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

# Settings: kept as they are on an update.
if [ ! -f "$ENV_FILE" ]; then
    cat >"$ENV_FILE" <<'ENV'
# plexamp-web settings (the same as the Docker image's; see the README).
# After a change: systemctl restart plexamp-web-config nginx plexamp-web
PLEX_SERVER_URL=
OLLAMA_URL=
OLLAMA_MODEL=
ENV
fi
chmod 600 "$ENV_FILE"

# nginx: the app's server, in place of Debian's default site.
rm -f /etc/nginx/sites-enabled/default
sed -e "s#root /usr/share/nginx/html;#root $BASE/html;#" "$BASE/app/docker/nginx.conf" >/etc/nginx/conf.d/default.conf
for inc in pms-proxy ai-proxy api log; do touch "/etc/nginx/conf.d/$inc.inc"; done

# `update-plexamp-web`: the newest version, with the same settings.
cat >/usr/local/bin/update-plexamp-web <<UPDATE
#!/bin/sh
# Updates plexamp-web to the newest version; settings are kept.
set -eu
tmp="\$(mktemp)"
trap 'rm -f "\$tmp"' EXIT
curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/proxmox/install.sh" -o "\$tmp"
PW_REPO="$REPO" PW_REF="$REF" bash "\$tmp"
UPDATE
chmod 755 /usr/local/bin/update-plexamp-web

# The start-up script the Docker image runs (it writes nginx's settings and
# the app's), then the service, then nginx. The service starts as root to
# read its settings and make its socket, then becomes www-data.
mkdir -p /etc/systemd/system/nginx.service.d
cat >/etc/systemd/system/plexamp-web-config.service <<UNIT
[Unit]
Description=plexamp-web: its settings, for nginx and the app
Before=nginx.service plexamp-web.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=$ENV_FILE
Environment=HTML_DIR=$BASE/html CONF_DIR=/etc/nginx/conf.d SERVICE_DIR=$BASE/app/server RUN_DIR=/run/plexamp-web SERVICE_USER=www-data SERVICE_START=false NGINX_ACCESS_LOG=syslog:server=unix:/dev/log,tag=nginx,nohostname
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
ExecStart=/usr/bin/node $BASE/app/server/index.js /run/plexamp-web/service.json
Restart=always
RestartSec=2
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT
cat >/etc/systemd/system/nginx.service.d/plexamp-web.conf <<UNIT
[Unit]
Requires=plexamp-web-config.service
After=plexamp-web-config.service
UNIT

if [ "$systemd" = true ]; then
    say "Starting plexamp-web"
    systemctl daemon-reload
    systemctl enable --quiet plexamp-web-config.service plexamp-web.service nginx.service
    systemctl restart plexamp-web-config.service
    systemctl restart plexamp-web.service
    systemctl restart nginx.service
    for _ in $(seq 1 30); do
        curl -fsS -o /dev/null http://127.0.0.1/api/health && break
        sleep 0.5
    done
    curl -fsS -o /dev/null http://127.0.0.1/ || fail "plexamp-web didn't start. See: journalctl -u plexamp-web-config -u plexamp-web -u nginx"
    say "plexamp-web is running"
else
    say "Installed. systemd isn't running here, so start it yourself."
fi
