#!/bin/sh
# Runs the built image against the mock Plex and Ollama servers and checks
# the proxies, the sign-in check and each setting. Used by CI; needs Docker.
#
#   docker build -t plexamp-web:test . && sh docker/test-container.sh plexamp-web:test
set -eu

IMAGE="${1:-plexamp-web:test}"
NET="pw-test-$$"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="python:3.12-alpine"
CURL="curlimages/curl:8.10.1"
FAILED=0

cleanup() {
    docker rm -f pw-plex pw-ollama pw-web pw-web2 pw-web3 pw-web4 pw-bad >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

pass() { echo "PASS $1"; }
fail() {
    echo "FAIL $1"
    FAILED=1
}

# curl from inside the test network: c prints the HTTP status (000 if there
# was no response), cb prints the body. Long-lived responses (streams,
# WebSockets) end with curl's time limit, which is expected here.
c() {
    out="$(docker run --rm --network "$NET" "$CURL" -sS -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || true)"
    echo "${out:-000}"
}
cb() { docker run --rm --network "$NET" "$CURL" -sS --max-time 20 "$@" 2>/dev/null || true; }

expect() { # name expected actual
    if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1: expected $2, got $3"; fi
}
contains() { # name needle haystack
    case "$3" in *"$2"*) pass "$1" ;; *) fail "$1: missing '$2' in: $(printf '%s' "$3" | head -c 300)" ;; esac
}

wait_http() { # container url
    for _ in $(seq 1 40); do
        [ "$(c "$2")" != 000 ] && return 0
        sleep 0.5
    done
    echo "timed out waiting for $2"
    docker logs "$1" 2>&1 | tail -20
    return 1
}

docker network create "$NET" >/dev/null
docker run -d --name pw-plex --network "$NET" -v "$ROOT/dev:/dev-scripts:ro" "$PY" python /dev-scripts/mock-plex.py 32400 --quiet >/dev/null
docker run -d --name pw-ollama --network "$NET" -v "$ROOT/dev:/dev-scripts:ro" "$PY" python /dev-scripts/mock-ollama.py --port 11434 --quiet >/dev/null
wait_http pw-plex "http://pw-plex:32400/identity?X-Plex-Token=t"
wait_http pw-ollama "http://pw-ollama:11434/api/version"
OLLAMA_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pw-ollama)"

# ---------- 1. Everything on; Ollama reached by a name from /etc/hosts ----------
docker run -d --name pw-web --network "$NET" --add-host "ollama.box:$OLLAMA_IP" \
    -e PLEX_SERVER_URL=http://pw-plex:32400 -e DISABLE_WEBSOCKETS=true \
    -e OLLAMA_URL=http://ollama.box:11434 -e OLLAMA_MODEL=llama3.1:8b "$IMAGE" >/dev/null
wait_http pw-web http://pw-web/
W=http://pw-web

contains "config.js has all settings" 'serverProxy: "pms/", websockets: false, ai: { proxy: "ollama/", model: "llama3.1:8b" }' "$(cb $W/config.js)"
expect "app is served" 200 "$(c $W/)"
expect "Plex proxy passes requests" 200 "$(c "$W/pms/library/sections?X-Plex-Token=t")"
expect "Plex proxy keeps the token (bad token refused)" 401 "$(c "$W/pms/library/sections?X-Plex-Token=bad")"
contains "Plex proxy keeps the query string" '"Music [Hi-Res]"' "$(cb "$W/pms/library/sections?X-Plex-Token=t")"
expect "WebSocket upgrade through /pms" 101 "$(c -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' --max-time 3 "$W/pms/:/websockets/notifications?X-Plex-Token=t")"
c "http://pw-plex:32400/__mock/config?ping=1" >/dev/null
contains "event stream through /pms arrives unbuffered" 'event: ping' "$(cb -N --max-time 4 "$W/pms/:/eventsource/notifications?X-Plex-Token=t")"
c "http://pw-plex:32400/__mock/config?ping=10" >/dev/null

expect "AI: no sign-in refused" 401 "$(c $W/ollama/api/tags)"
expect "AI: bad Plex token refused" 401 "$(c -H 'X-Plex-Token: bad' $W/ollama/api/tags)"
expect "AI: signed-in user allowed" 200 "$(c -H 'X-Plex-Token: t' $W/ollama/api/tags)"
expect "AI: shared-server token checked first" 401 "$(c -H 'X-Plex-Token: t' -H 'X-Plex-Server-Token: bad' $W/ollama/api/tags)"
contains "AI: models listed" '"llama3.1:8b"' "$(cb -H 'X-Plex-Token: t' $W/ollama/api/tags)"
CHAT='{"model":"llama3.1:8b","stream":true,"messages":[{"role":"user","content":"Reply with {\"ok\": true} and nothing else."}],"format":"json"}'
contains "AI: chat streams through the proxy (POST + sign-in check)" '"done": true' "$(cb -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d "$CHAT" $W/ollama/api/chat)"
expect "AI: browser Origin isn't passed to Ollama" 200 "$(c -H 'X-Plex-Token: t' -H 'Origin: http://evil.example' $W/ollama/api/tags)"
expect "AI: model downloads blocked" 404 "$(c -H 'X-Plex-Token: t' -X POST -d '{"model":"x"}' $W/ollama/api/pull)"
expect "AI: model deletion blocked" 404 "$(c -H 'X-Plex-Token: t' -X DELETE -d '{"model":"x"}' $W/ollama/api/delete)"
expect "AI: wrong method refused" 403 "$(c -H 'X-Plex-Token: t' -X DELETE $W/ollama/api/tags)"
expect "AI: other paths blocked" 404 "$(c -H 'X-Plex-Token: t' $W/ollama/)"
codes="$(docker run --rm --network "$NET" --entrypoint sh "$CURL" -c \
    "for i in \$(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' -H 'X-Plex-Token: ratelimit' $W/ollama/api/version; done" || true)"
contains "AI: rate limited per user" "429" "$codes"
docker logs pw-web 2>&1 | grep -q "WebSockets turned off" && pass "startup log explains settings" || fail "startup log explains settings"

# ---------- 2. Nothing set ----------
docker run -d --name pw-web2 --network "$NET" "$IMAGE" >/dev/null
wait_http pw-web2 http://pw-web2/
expect "defaults: empty config" "window.PW_CONFIG = {  };" "$(cb http://pw-web2/config.js | tr -d '\n')"
expect "defaults: /pms not proxied" 200 "$(c http://pw-web2/pms/identity)"
expect "defaults: /ollama off" 404 "$(c http://pw-web2/ollama/api/tags)"

# ---------- 3. AI open to anyone; Ollama host that doesn't exist yet ----------
docker run -d --name pw-web3 --network "$NET" -e OLLAMA_URL=http://not-started-yet:11434 -e OLLAMA_AUTH=off "$IMAGE" >/dev/null
wait_http pw-web3 http://pw-web3/
expect "starts even when Ollama's host isn't up yet" 200 "$(c http://pw-web3/)"
expect "unreachable Ollama gives a gateway error" 502 "$(c http://pw-web3/ollama/api/tags)"
docker rm -f pw-web3 >/dev/null
docker run -d --name pw-web3 --network "$NET" -e OLLAMA_URL=http://pw-ollama:11434 -e OLLAMA_AUTH=off "$IMAGE" >/dev/null
wait_http pw-web3 http://pw-web3/
expect "OLLAMA_AUTH=off: no sign-in needed" 200 "$(c http://pw-web3/ollama/api/tags)"

# ---------- 4. No Plex proxy: sign-in checked with plex.tv ----------
docker run -d --name pw-web4 --network "$NET" -e OLLAMA_URL=http://pw-ollama:11434 "$IMAGE" >/dev/null
wait_http pw-web4 http://pw-web4/
code="$(c -H 'X-Plex-Token: not-a-real-token' http://pw-web4/ollama/api/tags)"
if [ "$code" != 200 ] && [ "$code" != 000 ]; then pass "plex.tv check refuses a fake token ($code)"; else fail "plex.tv check refuses a fake token: got $code"; fi

# ---------- 5. Bad settings stop the container with a clear message ----------
bad() { # name expected-message docker-run-args...
    name="$1"
    msg="$2"
    shift 2
    docker rm -f pw-bad >/dev/null 2>&1 || true
    docker run -d --name pw-bad "$@" "$IMAGE" >/dev/null
    sleep 3
    contains "$name" "$msg" "$(docker logs pw-bad 2>&1 || true)"
    expect "$name: container stops" false "$(docker inspect -f '{{.State.Running}}' pw-bad 2>/dev/null || echo false)"
    docker rm -f pw-bad >/dev/null 2>&1 || true
}
bad "rejects a server address without http://" "PLEX_SERVER_URL must start with http://" -e PLEX_SERVER_URL=192.168.1.10:32400
bad "rejects an unclear true/false value" "expected true or false" -e DISABLE_WEBSOCKETS=maybe
bad "rejects an unknown OLLAMA_AUTH" "OLLAMA_AUTH must be plex or off" -e OLLAMA_URL=http://x:11434 -e OLLAMA_AUTH=sometimes
bad "rejects an address with odd characters" "invalid path" -e 'OLLAMA_URL=http://x:11434/;evil'

if [ "$FAILED" -ne 0 ]; then
    echo "--- pw-web log"
    docker logs pw-web 2>&1 | tail -40
    exit 1
fi
echo "All container checks passed"
