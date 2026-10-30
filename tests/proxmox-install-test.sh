#!/usr/bin/env bash
# Runs proxmox/install.sh (what the Proxmox script installs in its
# container) in Debian 12 and 13 containers, from this checkout, then starts
# what systemd would and checks the app answers. Used by CI; needs Docker.
#
#   bash tests/proxmox-install-test.sh [debian release ...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0
releases=("$@")
[ "${#releases[@]}" -gt 0 ] || releases=(12 13)

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

for release in "${releases[@]}"; do
    echo "--- Debian $release"
    if docker run --rm -v "$ROOT:/src:ro" "debian:$release" bash -c '
        set -euo pipefail
        PW_SOURCE_DIR=/src PW_NO_SYSTEMD=1 bash /src/proxmox/install.sh
        printf "PLEX_SERVER_URL=\nOLLAMA_URL=\nOLLAMA_MODEL=\nDISABLE_WEBSOCKETS=true\n" >/etc/plexamp-web/plexamp-web.env
        # What the systemd units do, read from the units install.sh wrote: the
        # settings, then the service as its user, then nginx.
        unit=/etc/systemd/system/plexamp-web.service
        config=/etc/systemd/system/plexamp-web-config.service
        configure() {
            (
                set -a
                . /etc/plexamp-web/plexamp-web.env
                set +a
                env "$@" $(sed -n "s/^Environment=//p" "$config") $(sed -n "s/^ExecStart=//p" "$config")
            )
        }
        configure
        user="$(sed -n "s/^User=//p" "$unit")"
        group="$(sed -n "s/^Group=//p" "$unit")"
        setpriv --reuid="$user" --regid="$group" --init-groups $(sed -n "s/^ExecStart=//p" "$unit") >/tmp/service.log 2>&1 &
        nginx -t -q
        nginx
        for _ in $(seq 1 40); do curl -fs -o /dev/null http://127.0.0.1/api/health && break; sleep 0.5; done
        echo "node $(node --version), $(nginx -v 2>&1), service as $user:$group"
        expect() { # name, then a command that must succeed
            local name="$1"
            shift
            if "$@" >/dev/null 2>&1; then
                echo "PASS $name"
            else
                echo "FAIL $name"
                echo "--- the service:"
                cat /tmp/service.log
                if [ -f /tmp/update.log ]; then echo "--- the last update:"; tail -n 20 /tmp/update.log; fi
                ls -la /run/plexamp-web
                echo "--- nginx:"
                tail -n 15 /var/log/nginx/error.log
                grep -hE "^(Name|Uid|Gid):" /proc/[0-9]*/status 2>/dev/null | paste - - - | grep -E "nginx|node" || true
                exit 1
            fi
        }
        expect "the app is served" sh -c "curl -fsS http://127.0.0.1/ | grep -q \"<title>\""
        expect "settings reach the app" sh -c "curl -fsS http://127.0.0.1/config.js | grep -q \"websockets: false\""
        expect "hls.js is bundled" curl -fsS -o /dev/null http://127.0.0.1/vendor/hls.min.js
        expect "the service answers through nginx" sh -c "curl -fsS http://127.0.0.1/api/health | grep -q \"\\\"ok\\\":true\""
        expect "settings readable by root only" test "$(stat -c %a /etc/plexamp-web/plexamp-web.env)" = 600
        expect "the service runs as www-data (its unit)" test "$user:$group" = "www-data:www-data"
        expect "the service'"'"'s own settings are root'"'"'s, readable by it alone" test "$(stat -c "%U:%G %a" /run/plexamp-web/service.json)" = "root:www-data 640"
        expect "...in a folder only root can change" test "$(stat -c "%U:%G %a" /run/plexamp-web)" = "root:www-data 750"
        expect "...with a folder of the service'"'"'s own for its socket" test "$(stat -c "%U %a" /run/plexamp-web/socket)" = "www-data 750"
        expect "shared playlists are on" sh -c "curl -fsS http://127.0.0.1/api/health | grep -q \"\\\"sharing\\\":true\""
        expect "...and kept in /var/lib/plexamp-web, the service'"'"'s alone" test "$(stat -c "%U %a" /var/lib/plexamp-web)" = "www-data 700"
        expect "update-plexamp-web is there" test -x /usr/local/bin/update-plexamp-web
        expect "plexamp-web-settings is there" test -x /usr/local/bin/plexamp-web-settings
        # pct exec runs commands with the search path Proxmox sets for itself,
        # without /usr/local/bin (0.10.0 and 0.11.0 put them only there).
        for cmd in update-plexamp-web plexamp-web-settings; do
            expect "pct exec finds $cmd" env -i PATH=/sbin:/bin:/usr/sbin:/usr/bin sh -c "test -x \"\$(command -v $cmd)\""
        done
        expect "systemd units are written" grep -q "SERVICE_START=false" "$config"
        service_ids() {
            local p
            for p in /proc/[0-9]*; do
                if tr "\0" " " <"$p/cmdline" 2>/dev/null | grep -q "^[^ ]*node [^ ]*[s]erver/index.js"; then
                    awk "/^Uid:/ { u = \$2 } /^Groups:/ { g = \$2 \$3 } END { print u \"/\" g }" "$p/status"
                    return
                fi
            done
        }
        expect "the service isn'"'"'t root, and has only its own group" test "$(service_ids)" = "33/33"
        # Debug mode: its access log goes to the journal, as the units set it.
        configure DEBUG=true >/dev/null
        expect "debug mode logs to the journal" grep -q "access_log syslog:server=unix:/dev/log" /etc/nginx/conf.d/log.inc
        expect "nginx takes debug mode'"'"'s settings" nginx -t -q
        # The Plex proxy, with nginx'"'"'s socket for the service'"'"'s own requests to the Plex server.
        configure PLEX_SERVER_URL=http://127.0.0.1:32400 >/dev/null
        expect "nginx takes the Plex proxy'"'"'s settings, and its socket for the service" nginx -t -q
        expect "...in a folder of root'"'"'s that only the service'"'"'s group can go into" test "$(stat -c "%U:%G %a" /run/plexamp-web/pms)" = "root:www-data 750"
        expect "...whose socket a stopped nginx left is gone before it starts" grep -q "^ExecStartPre=-/bin/rm -f /run/plexamp-web/pms/plex.sock$" /etc/systemd/system/nginx.service.d/plexamp-web.conf
        configure >/dev/null
        # Updates, as update-plexamp-web runs them, with this checkout for the
        # installer it downloads: first from the command 0.15.0 put there.
        # The installer replaces that command while it runs, and until 0.16.1
        # it changed the file where it stood, so the shell running it read on
        # into the new one, and the update ended with a "Syntax error".
        mkdir -p /tmp/stub
        cat >/tmp/stub/curl <<"STUB"
#!/bin/sh
out=""
url=""
w=""
prev=""
for a in "$@"; do
    case "$prev" in -o) out="$a" ;; -w) w=1 ;; esac
    case "$a" in https://raw.githubusercontent.com/*/proxmox/install.sh) url="$a" ;; esac
    prev="$a"
done
if [ -n "$url" ]; then
    cp /src/proxmox/install.sh "$out"
    if [ -n "$w" ]; then printf 200; fi
    exit 0
fi
exec /usr/bin/curl "$@"
STUB
        chmod 755 /tmp/stub/curl
        # update [VAR=value ...] update-plexamp-web [option]: an update, its output in /tmp/update.log.
        update() { env PATH="/tmp/stub:$PATH" PW_SOURCE_DIR=/src PW_NO_SYSTEMD=1 "$@" >/tmp/update.log 2>&1 && ! grep -q "Syntax error" /tmp/update.log; }
        quiet_update() { update update-plexamp-web && ! grep -q "^    " /tmp/update.log; }
        env_verbose_update() { update PW_VERBOSE=1 update-plexamp-web && grep -q "^    In detail: Debian" /tmp/update.log; }
        install -m 755 /src/tests/update-plexamp-web-0.15.0.sh /usr/local/bin/update-plexamp-web
        expect "update-plexamp-web from 0.15.0 finishes cleanly (the installer replaces it as it runs)" update update-plexamp-web
        expect "...and puts the new command in its place" grep -q "^exit$" /usr/local/bin/update-plexamp-web
        expect "update-plexamp-web as it is now finishes cleanly too" update update-plexamp-web
        expect "...leaving nothing behind next to it" sh -c "! ls /usr/local/bin/update-plexamp-web.?????? 2>/dev/null"
        expect "an update keeps the settings" grep -q "^DISABLE_WEBSOCKETS=true$" /etc/plexamp-web/plexamp-web.env
        # Offline mode'"'"'s settings as 0.30.0 named them: an update renames
        # them, keeping their values (the start-up script stops at the old
        # names), and 0.30.0'"'"'s words about them. (One with spaces before
        # it, which systemd doesn'"'"'t mind.)
        printf "%s\n" "# Where the offline key can be used from: private (your own networks), any," "OFFLINE_KEY=offline-pwd-for-tests" "  OFFLINE_FROM=private" >>/etc/plexamp-web/plexamp-web.env
        expect "an update renames 0.30.0'"'"'s OFFLINE_KEY and OFFLINE_FROM" update update-plexamp-web
        expect "...saying so" grep -q "OFFLINE_KEY and OFFLINE_FROM are called OFFLINE_PWD and OFFLINE_NETWORKS now" /tmp/update.log
        expect "...to OFFLINE_PWD, with its value" grep -qx "OFFLINE_PWD=offline-pwd-for-tests" /etc/plexamp-web/plexamp-web.env
        expect "...and OFFLINE_NETWORKS, with its value (spaces before it and all)" grep -qx "  OFFLINE_NETWORKS=private" /etc/plexamp-web/plexamp-web.env
        expect "...leaving neither old name" sh -c "! grep -qE \"^[[:space:]]*OFFLINE_(KEY|FROM)=\" /etc/plexamp-web/plexamp-web.env"
        expect "...with the words about them as they are now" grep -qx "# Where the offline password can be used from: private (your own networks), any," /etc/plexamp-web/plexamp-web.env
        expect "...keeping the rest as it was" grep -q "^DISABLE_WEBSOCKETS=true$" /etc/plexamp-web/plexamp-web.env
        expect "...and readable by root only" test "$(stat -c %a /etc/plexamp-web/plexamp-web.env)" = 600
        expect "...and the app starts with them" configure PLEX_SERVER_URL=http://127.0.0.1:32400
        expect "an update after that changes nothing more" sh -c "cp /etc/plexamp-web/plexamp-web.env /tmp/settings.before && env PATH=\"/tmp/stub:\$PATH\" PW_SOURCE_DIR=/src PW_NO_SYSTEMD=1 update-plexamp-web >/tmp/update.log 2>&1 && cmp -s /tmp/settings.before /etc/plexamp-web/plexamp-web.env && ! grep -q \"are called OFFLINE_PWD\" /tmp/update.log"
        sed -i -e "/^# Where the offline password can be used from:/d" -e "/^OFFLINE_PWD=/d" -e "/^[[:space:]]*OFFLINE_NETWORKS=/d" /etc/plexamp-web/plexamp-web.env
        configure >/dev/null
        # Every step in detail: --verbose, or PW_VERBOSE=1 (which commands
        # from before --verbose pass on to the installer too).
        expect "update-plexamp-web --help says how to use it" sh -c "update-plexamp-web --help | grep -q \"^Usage: update-plexamp-web \\[--verbose\\]\""
        expect "...and an option it doesn'"'"'t have changes nothing" sh -c "out=\"\$(update-plexamp-web --nope 2>&1)\"; test \$? = 2 && printf \"%s\" \"\$out\" | grep -q \"Nothing was changed\""
        expect "update-plexamp-web --verbose finishes" update update-plexamp-web --verbose
        expect "...showing each step" grep -q "^    The installer, https://raw.githubusercontent.com/.*: HTTP 200$" /tmp/update.log
        expect "...with the tools'"'"' own output (apt-get'"'"'s here)" grep -q "^      Reading package lists" /tmp/update.log
        expect "...and the checksum hls.js matched" grep -q "^    Its checksum, as the registry gives it: sha512-" /tmp/update.log
        expect "without it, an update is as quiet as before" quiet_update
        install -m 755 /src/tests/update-plexamp-web-0.15.0.sh /usr/local/bin/update-plexamp-web
        expect "PW_VERBOSE=1 shows each step from an older update-plexamp-web too" env_verbose_update
    ' >"$LOG" 2>&1; then
        cat "$LOG"
        echo "Debian $release: OK"
    else
        cat "$LOG"
        echo "FAIL Debian $release"
        # The end of its output, on the run's summary page too.
        if [ -n "${GITHUB_ACTIONS:-}" ]; then
            echo "::error title=Proxmox install test (Debian $release)::$(grep -v '^curl: ' "$LOG" | tail -n 60 | cut -c1-300 | sed -e 's/%/%25/g' -e 's/\r//g' | awk '{ printf "%s%%0A", $0 }')"
        fi
        FAILED=1
    fi
done
exit "$FAILED"
