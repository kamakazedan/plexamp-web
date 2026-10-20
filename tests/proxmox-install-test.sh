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
        expect "the service'"'"'s own settings are its, and no one else'"'"'s" test "$(stat -c "%U %a" /run/plexamp-web/service.json)" = "www-data 600"
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
        # An update keeps the settings.
        PW_SOURCE_DIR=/src PW_NO_SYSTEMD=1 bash /src/proxmox/install.sh >/dev/null
        expect "an update keeps the settings" grep -q "^DISABLE_WEBSOCKETS=true$" /etc/plexamp-web/plexamp-web.env
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
