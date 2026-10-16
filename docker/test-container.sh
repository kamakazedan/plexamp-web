#!/bin/sh
# Runs the built image against the mock Plex and Ollama servers and checks
# the proxies, the sign-in checks, the service behind /api/, logging and each
# setting. Used by CI; needs Docker.
#
#   docker build -t plexamp-web:test . && sh docker/test-container.sh plexamp-web:test
#
# The containers' service uses the mock for plex.tv too (PLEX_TV_URL), whose
# accounts are t (Dan, who owns the server), t2 (Sam, a friend with access)
# and t3 (Alex, a friend without access). Dan also has a Plex player, which
# the mock runs on port 32500 at its address on the test network.
set -eu

IMAGE="${1:-plexamp-web:test}"
NET="pw-test-$$"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="python:3.12-alpine"
CURL="curlimages/curl:8.10.1"
FAILED=0
TV="PLEX_TV_URL=http://pw-plex:32400"

cleanup() {
    docker rm -f pw-plex pw-ollama pw-web pw-web2 pw-web3 pw-web4 pw-web5 pw-web6 pw-web7 pw-web8 pw-bad >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

pass() { echo "PASS $1"; }
fail() {
    echo "FAIL $1"
    # In GitHub Actions, also an annotation on the run's summary page.
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        echo "::error title=Container test::$(printf '%s' "$1" | tr '\r\n' '  ' | sed 's/%/%25/g' | cut -c1-900)"
    fi
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
lacks() { # name needle haystack
    case "$3" in *"$2"*) fail "$1: found '$2'" ;; *) pass "$1" ;; esac
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

# The service starts alongside nginx; wait until it answers.
wait_service() { # container
    for _ in $(seq 1 40); do
        [ "$(c "http://$1/api/health")" = 200 ] && return 0
        sleep 0.5
    done
    echo "timed out waiting for the service in $1"
    docker logs "$1" 2>&1 | tail -20
    return 1
}

docker network create "$NET" >/dev/null
docker run -d --name pw-plex --network "$NET" -v "$ROOT/dev:/dev-scripts:ro" "$PY" python /dev-scripts/mock-plex.py 32400 --quiet >/dev/null
docker run -d --name pw-ollama --network "$NET" -v "$ROOT/dev:/dev-scripts:ro" "$PY" python /dev-scripts/mock-ollama.py --port 11434 --quiet >/dev/null
wait_http pw-plex "http://pw-plex:32400/identity"
wait_http pw-ollama "http://pw-ollama:11434/api/version"
OLLAMA_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pw-ollama)"

# ---------- 1. Everything on; Ollama reached by a name from /etc/hosts ----------
docker run -d --name pw-web --network "$NET" --add-host "ollama.box:$OLLAMA_IP" -e "$TV" \
    -e PLEX_SERVER_URL=http://pw-plex:32400 -e DISABLE_WEBSOCKETS=true \
    -e OLLAMA_URL=http://ollama.box:11434 -e OLLAMA_MODEL=llama3.1:8b "$IMAGE" >/dev/null
wait_http pw-web http://pw-web/
wait_service pw-web
W=http://pw-web

contains "config.js has all settings" 'serverProxy: "pms/", websockets: false, ai: { proxy: "ollama/", model: "llama3.1:8b" }, together: true, cast: true' "$(cb $W/config.js)"
expect "app is served" 200 "$(c $W/)"
expect "hls.js is bundled" 200 "$(c $W/vendor/hls.min.js)"
lacks "nginx's version isn't shown" "nginx/" "$(docker run --rm --network "$NET" "$CURL" -sSI --max-time 20 $W/ 2>/dev/null || true)"
contains "scripts only from the player itself" "script-src 'self';" "$(docker run --rm --network "$NET" "$CURL" -sSI --max-time 20 $W/ 2>/dev/null || true)"

expect "Plex proxy passes requests" 200 "$(c "$W/pms/library/sections?X-Plex-Token=t")"
expect "Plex proxy passes a friend's requests" 200 "$(c "$W/pms/library/sections?X-Plex-Token=t2")"
expect "Plex proxy keeps the token (bad token refused)" 401 "$(c "$W/pms/library/sections?X-Plex-Token=bad")"
expect "Plex proxy refuses requests without a token" 401 "$(c "$W/pms/library/sections")"
expect "Plex proxy accepts the token as a header" 200 "$(c -H 'X-Plex-Token: t' "$W/pms/library/sections")"
expect "converted streams' session files need no token" 200 "$(c "$W/pms/audio/:/transcode/universal/session/abc-1/base/index.m3u8")"
expect "...but only real session paths" 401 "$(c --path-as-is "$W/pms/audio/:/transcode/universal/session/abc-1/../../../../../library/sections")"
contains "Plex proxy keeps the query string" '"Music [Hi-Res]"' "$(cb "$W/pms/library/sections?X-Plex-Token=t")"
headers() { docker run --rm --network "$NET" "$CURL" -sS -o /dev/null -D - --max-time 20 "$@" 2>/dev/null | tr -d '\r' || true; }
contains "artwork can be kept by the browser for a day" "Cache-Control: private, max-age=86400" \
    "$(headers "$W/pms/photo/:/transcode?url=/library/metadata/120/thumb/1&width=100&height=100&X-Plex-Token=t")"
lacks "...but not other answers from Plex" "max-age" "$(headers "$W/pms/library/sections?X-Plex-Token=t")"
contains "...which are checked every time" "Cache-Control: no-cache" "$(headers "$W/pms/library/sections?X-Plex-Token=t")"
expect "WebSocket upgrade through /pms" 101 "$(c -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' --max-time 3 "$W/pms/:/websockets/notifications?X-Plex-Token=t")"
c "http://pw-plex:32400/__mock/config?ping=1" >/dev/null
contains "event stream through /pms arrives unbuffered" 'event: ping' "$(cb -N --max-time 4 "$W/pms/:/eventsource/notifications?X-Plex-Token=t")"
c "http://pw-plex:32400/__mock/config?ping=10" >/dev/null

expect "AI: no sign-in refused" 401 "$(c $W/ollama/api/tags)"
expect "AI: bad Plex token refused" 401 "$(c -H 'X-Plex-Token: bad' $W/ollama/api/tags)"
expect "AI: signed-in owner allowed" 200 "$(c -H 'X-Plex-Token: t' $W/ollama/api/tags)"
expect "AI: friend with access to the server allowed" 200 "$(c -H 'X-Plex-Token: t2' $W/ollama/api/tags)"
expect "AI: Plex account without access to the server refused" 403 "$(c -H 'X-Plex-Token: t3' $W/ollama/api/tags)"
expect "AI: a server token works when the account token doesn't" 200 "$(c -H 'X-Plex-Token: bad' -H 'X-Plex-Server-Token: t2' $W/ollama/api/tags)"
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

contains "service: health" '"together":true,"cast":true' "$(cb $W/api/health)"
expect "service: internal checks can't be called from outside" 404 "$(c -H 'X-Plex-Token: t' $W/api/internal/ai-auth)"
expect "Play Together: needs a sign-in" 401 "$(c $W/api/together/me)"
expect "Play Together: refuses a bad token" 401 "$(c -H 'X-Plex-Token: bad' $W/api/together/me)"
contains "Play Together: knows who you are" '"title":"Dan"' "$(cb -H 'X-Plex-Token: t' $W/api/together/me)"
lacks "Play Together: doesn't hand out email addresses" "@example.com" "$(cb -H 'X-Plex-Token: t' $W/api/together/friends?server=mock-server-1)"
contains "Play Together: lists friends with their access" '"title":"Alex","thumb":"https://plex.tv/users/a1003/avatar?c=1","home":false,"canPlay":false' "$(cb -H 'X-Plex-Token: t' "$W/api/together/friends?server=mock-server-1")"
SESSION='{"server":{"id":"mock-server-1","name":"Test","section":"1","sectionTitle":"Music"},"invite":[1002,1003],"queue":[{"id":"120","title":"A","duration":20000,"partKey":"/library/parts/120/0/file.flac","thumb":"https://evil.example/x.png"}],"playing":true}'
created="$(cb -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d "$SESSION" $W/api/together/sessions)"
contains "Play Together: starts a session" '"role":"host"' "$created"
lacks "Play Together: outside artwork addresses are dropped" "evil.example" "$created"
SID="$(printf '%s' "$created" | sed -n 's/^{"id":"\([A-Za-z0-9_-]*\)".*/\1/p')"
contains "Play Together: invited friend sees the invitation" "\"id\":\"$SID\",\"role\":\"invited\"" "$(cb -H 'X-Plex-Token: t2' $W/api/together/me)"
expect "Play Together: a friend without access can't join" 403 "$(c -H 'X-Plex-Token: t3' -X POST $W/api/together/sessions/$SID/join)"
expect "Play Together: the invited friend joins" 200 "$(c -H 'X-Plex-Token: t2' -X POST $W/api/together/sessions/$SID/join)"
expect "Play Together: members can control it" 200 "$(c -H 'X-Plex-Token: t2' -H 'Content-Type: application/json' -X POST -d '{"type":"pause"}' $W/api/together/sessions/$SID/command)"
expect "Play Together: oversized requests refused" 413 "$(docker run --rm --network "$NET" --entrypoint sh "$CURL" -c \
    "head -c 700000 /dev/zero | tr '\\0' 'a' > /tmp/big; curl -s -o /dev/null -w '%{http_code}' -H 'X-Plex-Token: t2' -H 'Content-Type: application/json' -X POST --data-binary @/tmp/big $W/api/together/sessions/$SID/command" || true)"
contains "Play Together: long-polling answers when something changes" '"playing":true' "$(docker run --rm --network "$NET" --entrypoint sh "$CURL" -c \
    "(sleep 1; curl -s -o /dev/null -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d '{\"type\":\"play\"}' $W/api/together/sessions/$SID/command) & curl -s --max-time 20 -H 'X-Plex-Token: t2' '$W/api/together/sessions/$SID?since=999999&wait=10'; wait" || true)"
expect "Play Together: the host ends it" 200 "$(c -H 'X-Plex-Token: t' -X DELETE $W/api/together/sessions/$SID)"
CMD='Content-Type: application/json'
expect "Play on: needs a sign-in" 401 "$(c $W/api/cast/players)"
players="$(cb -H 'X-Plex-Token: t' $W/api/cast/players)"
contains "Play on: lists the owner's Plex players" '"id":"mock-player-1","name":"Living Room"' "$players"
lacks "Play on: players' addresses stay in the container" '"url"' "$players"
expect "Play on: only for the server's owner" 403 "$(c -H 'X-Plex-Token: t2' $W/api/cast/players)"
expect "Play on: commands reach the player on the network" 200 "$(c -H 'X-Plex-Token: t' -H "$CMD" -X POST -d '{"command":"setParameters","volume":50}' $W/api/cast/players/mock-player-1/command)"
contains "Play on: reads what the player is doing" '"state":"' "$(cb -H 'X-Plex-Token: t' $W/api/cast/players/mock-player-1/timeline)"
expect "Play on: only players on the account" 404 "$(c -H 'X-Plex-Token: t' -H "$CMD" -X POST -d '{"command":"pause"}' $W/api/cast/players/somebody-else/command)"
expect "Play on: only commands it knows" 400 "$(c -H 'X-Plex-Token: t' -H "$CMD" -X POST -d '{"command":"../../resources"}' $W/api/cast/players/mock-player-1/command)"
expect "Play on: friends can't send commands either" 403 "$(c -H 'X-Plex-Token: t2' -H "$CMD" -X POST -d '{"command":"pause"}' $W/api/cast/players/mock-player-1/command)"
docker logs pw-web 2>&1 | grep -q "WebSockets turned off" && pass "startup log explains settings" || fail "startup log explains settings"
docker logs pw-web 2>&1 | grep -q "plexamp-web service: ready" && pass "the service started" || fail "the service started"
LOG="$(docker logs pw-web 2>&1)"
lacks "no access log by default (tokens travel in Plex addresses)" "/pms/library/sections" "$LOG"
lacks "no tokens in the log" "X-Plex-Token=t" "$LOG"

# ---------- 2. Nothing set ----------
docker run -d --name pw-web2 --network "$NET" "$IMAGE" >/dev/null
wait_http pw-web2 http://pw-web2/
wait_service pw-web2
expect "defaults: Play Together and Play on, nothing else" "window.PW_CONFIG = { together: true, cast: true };" "$(cb http://pw-web2/config.js | tr -d '\n')"
expect "defaults: /pms not proxied" 200 "$(c http://pw-web2/pms/identity)"
expect "defaults: /ollama off" 404 "$(c http://pw-web2/ollama/api/tags)"
expect "defaults: Play Together needs a sign-in" 401 "$(c http://pw-web2/api/together/me)"

# ---------- 3. AI open to anyone; Ollama host that doesn't exist yet ----------
docker run -d --name pw-web3 --network "$NET" -e OLLAMA_URL=http://not-started-yet:11434 -e OLLAMA_AUTH=off "$IMAGE" >/dev/null
wait_http pw-web3 http://pw-web3/
expect "starts even when Ollama's host isn't up yet" 200 "$(c http://pw-web3/)"
expect "unreachable Ollama gives a gateway error" 502 "$(c http://pw-web3/ollama/api/tags)"
docker rm -f pw-web3 >/dev/null
docker run -d --name pw-web3 --network "$NET" -e OLLAMA_URL=http://pw-ollama:11434 -e OLLAMA_AUTH=off "$IMAGE" >/dev/null
wait_http pw-web3 http://pw-web3/
expect "OLLAMA_AUTH=off: no sign-in needed" 200 "$(c http://pw-web3/ollama/api/tags)"

# ---------- 4. No Plex proxy: sign-in checked with the real plex.tv ----------
docker run -d --name pw-web4 --network "$NET" -e OLLAMA_URL=http://pw-ollama:11434 "$IMAGE" >/dev/null
wait_http pw-web4 http://pw-web4/
wait_service pw-web4
code="$(c -H 'X-Plex-Token: not-a-real-token' http://pw-web4/ollama/api/tags)"
if [ "$code" != 200 ] && [ "$code" != 000 ]; then pass "plex.tv check refuses a fake token ($code)"; else fail "plex.tv check refuses a fake token: got $code"; fi

# ---------- 5. A Plex server that lets this network in without signing in ----------
c "http://pw-plex:32400/__mock/config?open=1" >/dev/null
docker run -d --name pw-web5 --network "$NET" -e "$TV" -e PLEX_SERVER_URL=http://pw-plex:32400 \
    -e OLLAMA_URL=http://pw-ollama:11434 "$IMAGE" >/dev/null
wait_http pw-web5 http://pw-web5/
wait_service pw-web5
expect "open server: made-up tokens refused at /pms/" 401 "$(c "http://pw-web5/pms/library/sections?X-Plex-Token=made-up-token")"
expect "open server: accounts without access refused at /pms/" 403 "$(c "http://pw-web5/pms/library/sections?X-Plex-Token=t3")"
expect "open server: the owner still gets in" 200 "$(c "http://pw-web5/pms/library/sections?X-Plex-Token=t")"
# The server would treat a friend's requests as its owner's, so only the
# owner gets through.
expect "open server: friends are refused (they'd act as the owner)" 403 "$(c "http://pw-web5/pms/library/sections?X-Plex-Token=t2")"
expect "open server: ...and can't change things" 403 "$(c -X PUT "http://pw-web5/pms/playlists/999999?title=x&X-Plex-Token=t2")"
expect "open server: the owner can change things" 404 "$(c -X PUT "http://pw-web5/pms/playlists/999999?title=x&X-Plex-Token=t")"
expect "open server: shared AI not opened up by it" 401 "$(c -H 'X-Plex-Token: made-up-token' http://pw-web5/ollama/api/tags)"
docker logs pw-web5 2>&1 | grep -q "lets this container in without signing in" && pass "open server: the log explains" || fail "open server: the log explains"
c "http://pw-plex:32400/__mock/config?open=0" >/dev/null

# ---------- 6. Debug mode ----------
docker run -d --name pw-web6 --network "$NET" -e "$TV" -e DEBUG=true -e PLEX_SERVER_URL=http://pw-plex:32400 \
    -e OLLAMA_URL=http://pw-ollama:11434 -e OLLAMA_API_KEY=sk-test-secret-123 "$IMAGE" >/dev/null
wait_http pw-web6 http://pw-web6/
wait_service pw-web6
contains "debug: config.js says so" "debug: true" "$(cb http://pw-web6/config.js)"
c "http://pw-web6/pms/library/sections?X-Plex-Token=t" >/dev/null
c "http://pw-web6/pms/library/metadata/999999?X-Plex-Token=t2" >/dev/null
c -H 'X-Plex-Token: t' http://pw-web6/ollama/api/tags >/dev/null
c -H 'Content-Type: application/json' -X POST -d '{"client":"test","entries":[{"level":"warn","area":"player","message":"GET /pms/x?X-Plex-Token=t2 failed\nfake: injected line"}]}' http://pw-web6/api/debug/log >/dev/null
sleep 4
LOG="$(docker logs pw-web6 2>&1)"
contains "debug: settings are shown" "debug mode is on" "$LOG"
contains "debug: secrets show only as set" "OLLAMA_API_KEY: set" "$LOG"
contains "debug: connection checks" "check: Plex server (PLEX_SERVER_URL) answered with HTTP 200" "$LOG"
contains "debug: requests logged as paths" '"GET /pms/library/sections" 200' "$LOG"
contains "debug: browser problems logged" "plexamp-web browser test: warn player:" "$LOG"
lacks "debug: browsers can't add log lines" "
fake: injected line" "$LOG"
lacks "debug: no tokens in the log" "X-Plex-Token=t" "$LOG"
lacks "debug: no API key in the log" "sk-test-secret-123" "$LOG"
expect "without debug mode browsers can't write to the log" 404 "$(c -H 'Content-Type: application/json' -X POST -d '{"entries":[]}' http://pw-web/api/debug/log)"

# ---------- 7. Play Together off ----------
docker run -d --name pw-web7 --network "$NET" -e PLAY_TOGETHER=false "$IMAGE" >/dev/null
wait_http pw-web7 http://pw-web7/
wait_service pw-web7
expect "PLAY_TOGETHER=false: not in config.js" "window.PW_CONFIG = { cast: true };" "$(cb http://pw-web7/config.js | tr -d '\n')"
expect "PLAY_TOGETHER=false: no sessions" 404 "$(c -H 'X-Plex-Token: t' http://pw-web7/api/together/me)"

# ---------- 7b. Playing on other Plex players off ----------
docker run -d --name pw-web8 --network "$NET" -e "$TV" -e CASTING=false "$IMAGE" >/dev/null
wait_http pw-web8 http://pw-web8/
wait_service pw-web8
expect "CASTING=false: not in config.js" "window.PW_CONFIG = { together: true };" "$(cb http://pw-web8/config.js | tr -d '\n')"
expect "CASTING=false: no players" 404 "$(c -H 'X-Plex-Token: t' http://pw-web8/api/cast/players)"

# ---------- 8. Bad settings stop the container with a clear message ----------
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
bad "rejects an unclear PLAY_TOGETHER" "PLAY_TOGETHER: expected true or false" -e PLAY_TOGETHER=sometimes
bad "rejects an unclear CASTING" "CASTING: expected true or false" -e CASTING=sometimes
bad "rejects an unknown OLLAMA_AUTH" "OLLAMA_AUTH must be plex or off" -e OLLAMA_URL=http://x:11434 -e OLLAMA_AUTH=sometimes
bad "rejects an address with odd characters" "invalid path" -e 'OLLAMA_URL=http://x:11434/;evil'
docker rm -f pw-bad >/dev/null 2>&1 || true
docker run -d --name pw-bad -e 'PLEX_SERVER_URL=http://user:hunter2@plex.box:32400' "$IMAGE" >/dev/null
sleep 3
lacks "a password in an address isn't printed" "hunter2" "$(docker logs pw-bad 2>&1 || true)"

if [ "$FAILED" -ne 0 ]; then
    for n in pw-web pw-web5 pw-web6; do
        echo "--- $n log"
        docker logs "$n" 2>&1 | tail -40
    done
    exit 1
fi
echo "All container checks passed"
