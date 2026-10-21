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
DATA_VOLUME="pw-data-$$"
LINK_VOLUME="pw-link-$$"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="python:3.12-alpine"
CURL="curlimages/curl:8.10.1"
FAILED=0
TV="PLEX_TV_URL=http://pw-plex:32400"
CERTS=""

cleanup() {
    docker rm -f pw-plex pw-plex-tls pw-plex-self pw-ollama pw-web pw-web2 pw-web3 pw-web4 pw-web5 pw-web6 pw-web7 pw-web8 pw-web9 pw-web10 pw-bad >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker volume rm "$DATA_VOLUME" "$LINK_VOLUME" >/dev/null 2>&1 || true
    if [ -n "$CERTS" ]; then rm -rf "$CERTS"; fi
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
    -e OLLAMA_URL=http://ollama.box:11434 -e OLLAMA_MODEL=llama3.1:8b \
    -e MUSICBRAINZ_URL=http://pw-plex:32400 "$IMAGE" >/dev/null
wait_http pw-web http://pw-web/
wait_service pw-web
W=http://pw-web

contains "config.js has all settings" 'serverProxy: "pms/", websockets: false, ai: { proxy: "ollama/", model: "llama3.1:8b" }, together: true, cast: true, musicbrainz: "own"' "$(cb $W/config.js)"
expect "app is served" 200 "$(c $W/)"
expect "hls.js is bundled" 200 "$(c $W/vendor/hls.min.js)"
# The service starts as root to make its socket, then gives up root and
# root's groups (a container gives root several).
svc="$(docker exec pw-web sh -c 'for p in /proc/[0-9]*; do if tr "\0" " " <"$p/cmdline" 2>/dev/null | grep -q "^[^ ]*node [^ ]*[s]erver/index.js"; then grep -E "^(Uid|Gid|Groups):" "$p/status"; break; fi; done' 2>/dev/null || true)"
svc_uid="$(printf '%s\n' "$svc" | awk '/^Uid:/ { print $2 }')"
svc_gid="$(printf '%s\n' "$svc" | awk '/^Gid:/ { print $2 }')"
svc_groups="$(printf '%s\n' "$svc" | awk '/^Groups:/ { $1 = ""; print }' | xargs)"
expect "the service isn't root" yes "$(if [ -n "$svc_uid" ] && [ "$svc_uid" != 0 ]; then echo yes; else echo "no (uid ${svc_uid:-unknown})"; fi)"
expect "the service has none of root's groups" "${svc_gid:-unknown}" "${svc_groups:-none}"
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
contains "...which the browser doesn't keep at all (their addresses have tokens in them)" "Cache-Control: no-store" "$(headers "$W/pms/library/sections?X-Plex-Token=t")"
contains "...nor the service's answers" "Cache-Control: no-store" "$(headers -H 'X-Plex-Token: t' "$W/api/together/me")"
contains "the app's own files are checked every time" "Cache-Control: no-cache" "$(headers "$W/")"
contains "signing out asks the browser to forget what it kept from here" 'Clear-Site-Data: "cache"' "$(headers "$W/signed-out")"
lacks "...and only then" "Clear-Site-Data" "$(headers "$W/")"
expect "nothing whose name starts with a dot is served" 404 "$(c "$W/.env")"
expect "WebSocket upgrade through /pms" 101 "$(c -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' --max-time 3 "$W/pms/:/websockets/notifications?X-Plex-Token=t")"
lacks "...but no other protocol is switched to" "101" "$(c -H 'Connection: Upgrade' -H 'Upgrade: h2c' --max-time 3 "$W/pms/identity?X-Plex-Token=t")"
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
lacks "AI: the AI server's other models aren't shown" 'qwen2.5' "$(cb -H 'X-Plex-Token: t' $W/ollama/api/tags)"
contains "AI: says whether the model is ready" '"model":"llama3.1:8b","ready":true' "$(cb -H 'X-Plex-Token: t' $W/ollama/api/status)"
expect "AI: the AI server's version isn't passed on" 404 "$(c -H 'X-Plex-Token: t' $W/ollama/api/version)"
contains "AI: only the shared model is used, whatever a request asks for" '"model": "llama3.1:8b"' "$(cb -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d '{"model":"qwen2.5:7b","stream":false,"messages":[{"role":"user","content":"Reply with {\"ok\": true} and nothing else."}],"format":"json"}' $W/ollama/api/chat)"
contains "AI: someone without access is told why" 'can use its Plex server' "$(cb -H 'X-Plex-Token: t3' $W/ollama/api/status)"
expect "AI: the service's own AI path can't be called directly" 404 "$(c -H 'X-Plex-Token: t' $W/api/ai/status)"
expect "AI: ...nor with a backslash in its path" 404 "$(c --path-as-is -H 'X-Plex-Token: t' "$W/api/\\ai/status")"
expect "AI: ...nor saying it came the AI proxy's way" 404 "$(c -H 'X-Plex-Token: t' -H 'X-PW-Route: ai' "$W/api/together/../ai/status")"
CHAT='{"model":"llama3.1:8b","stream":true,"messages":[{"role":"user","content":"Reply with {\"ok\": true} and nothing else."}],"format":"json"}'
contains "AI: chat streams through the proxy (POST + sign-in check)" '"done": true' "$(cb -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d "$CHAT" $W/ollama/api/chat)"
expect "AI: browser Origin isn't passed to Ollama" 200 "$(c -H 'X-Plex-Token: t' -H 'Origin: http://evil.example' $W/ollama/api/tags)"
expect "AI: model downloads blocked" 404 "$(c -H 'X-Plex-Token: t' -X POST -d '{"model":"x"}' $W/ollama/api/pull)"
expect "AI: model deletion blocked" 404 "$(c -H 'X-Plex-Token: t' -X DELETE -d '{"model":"x"}' $W/ollama/api/delete)"
expect "AI: wrong method refused" 403 "$(c -H 'X-Plex-Token: t' -X DELETE $W/ollama/api/tags)"
expect "AI: other paths blocked" 404 "$(c -H 'X-Plex-Token: t' $W/ollama/)"
codes="$(docker run --rm --network "$NET" --entrypoint sh "$CURL" -c \
    "for i in \$(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' -H 'X-Plex-Token: ratelimit' $W/ollama/api/status; done" || true)"
contains "AI: rate limited per user" "429" "$codes"
# What Ollama says when a chat fails (a crashed model, say) stays in the log:
# it can say where the AI server is, and what's on it.
c "http://pw-ollama:11434/__mock/config?fail=1" >/dev/null
failed_chat="$(cb -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d "$CHAT" $W/ollama/api/chat)"
c "http://pw-ollama:11434/__mock/config?fail=0" >/dev/null
contains "AI: a chat that fails says so" "The AI server couldn’t answer" "$failed_chat"
lacks "AI: ...without what Ollama said about the server" "llama runner" "$failed_chat"
contains "AI: ...which is in the log" "llama runner process has terminated" "$(docker logs pw-web 2>&1)"
c "http://pw-ollama:11434/__mock/config?fail=2" >/dev/null
failed_chat="$(cb -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d "$CHAT" $W/ollama/api/chat)"
c "http://pw-ollama:11434/__mock/config?fail=0" >/dev/null
contains "AI: a chat that fails partway through says so too" "couldn’t finish the answer" "$failed_chat"
lacks "AI: ...without what Ollama said" "llama runner" "$failed_chat"

# MusicBrainz checks (the mock Plex server has a small MusicBrainz): for
# people who can use the server, as the shared model is.
MBQ='{"items":[{"kind":"artist","artist":"Real Missing Band"},{"kind":"artist","artist":"Not A Real Band"},{"kind":"track","artist":"Glass Harbour","title":"Sea Glass"}]}'
JSON='Content-Type: application/json'
expect "MusicBrainz: needs a sign-in" 401 "$(c -H "$JSON" -X POST -d "$MBQ" $W/api/musicbrainz/check)"
expect "MusicBrainz: Plex account without access to the server refused" 403 "$(c -H 'X-Plex-Token: t3' -H "$JSON" -X POST -d "$MBQ" $W/api/musicbrainz/check)"
expect "MusicBrainz: only POST" 405 "$(c -H 'X-Plex-Token: t2' $W/api/musicbrainz/check)"
contains "MusicBrainz: says which are real, unknown, or albums" '{"results":["real","unknown","album"]}' "$(cb -H 'X-Plex-Token: t2' -H "$JSON" -X POST -d "$MBQ" $W/api/musicbrainz/check)"
MB_SEEN="$(cb 'http://pw-plex:32400/__mock/musicbrainz?X-Plex-Token=t')"
contains "MusicBrainz: asks as this app, with its version" '"plexamp-web/' "$MB_SEEN"
contains "MusicBrainz: ...and where to find it" ' ( https://github.com/kamakazedan/plexamp-web )' "$MB_SEEN"

contains "service: health" '"together":true,"cast":true,"devices":true,"sharing":true' "$(cb $W/api/health)"
expect "service: internal checks can't be called from outside" 404 "$(c -H 'X-Plex-Token: t' $W/api/internal/ai-auth)"
expect "service: ...nor with a backslash in the path (read as / by the service)" 404 "$(c --path-as-is -H 'X-Plex-Token: t' "$W/api/\\internal/pms-auth")"
expect "service: ...nor with dots in it" 404 "$(c --path-as-is -H 'X-Plex-Token: t' "$W/api/together/../internal/pms-auth")"
# With PLEX_SERVER_URL set, the service is for people who can use that
# server (Alex can't, though he has a server of his own).
expect "Play Together: only on a server you can use" 403 "$(c -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d '{"server":{"id":"another-server","name":"x","section":"1"},"queue":[]}' $W/api/together/sessions)"
expect "Play Together: not for someone who can't use this player's server, even on their own" 403 "$(c -H 'X-Plex-Token: t3' -H 'Content-Type: application/json' -X POST -d '{"server":{"id":"mock-server-2","name":"x","section":"1"},"queue":[]}' $W/api/together/sessions)"
expect "Your devices: not for someone who can't use this player's server, even on their own" 403 "$(c -H 'X-Plex-Token: t3' "$W/api/devices?device=chk-device-9&name=Check&server=mock-server-2&wait=0")"
expect "shares: not for someone who can't use this player's server, even on their own" 403 "$(c -H 'X-Plex-Token: t3' -H 'Content-Type: application/json' -X POST -d '{"server":"mock-server-2","playlist":"1","title":"x","tracks":["1"]}' $W/api/shares)"
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
DEV='device=chk-device-1&name=Check&server=mock-server-1'
expect "Your devices: needs a sign-in" 401 "$(c "$W/api/devices?$DEV&wait=0")"
expect "Your devices: only for people who can use the server" 403 "$(c -H 'X-Plex-Token: t3' "$W/api/devices?$DEV&wait=0")"
contains "Your devices: a device sees your devices" '"you":"chk-device-1"' "$(cb -H 'X-Plex-Token: t' "$W/api/devices?$DEV&wait=0")"
expect "Your devices: a device needs a proper id" 400 "$(c -H 'X-Plex-Token: t' "$W/api/devices?device=x&server=mock-server-1&wait=0")"
expect "Your devices: only the one playing says what's playing" 409 "$(c -H 'X-Plex-Token: t' -H "$CMD" -X POST -d '{"server":"mock-server-1","device":{"id":"chk-device-1","name":"Check"},"qid":"1","playing":true}' $W/api/devices/report)"
lacks "Your devices: one account doesn't see another's" '"chk-device-1"' "$(cb -H 'X-Plex-Token: t2' "$W/api/devices?device=chk-device-2&name=Sam&server=mock-server-1&wait=0")"
docker logs pw-web 2>&1 | grep -q "WebSockets turned off" && pass "startup log explains settings" || fail "startup log explains settings"
# Shared playlists: only with your own Plex friends who can use the
# server; only those it's shared with see it; kept in /data, the service's
# own, without anyone's sign-in, and still there after a restart.
SHARE='{"server":"mock-server-1","playlist":"5000","title":"Shared test","tracks":["120","121"],"members":[{"id":1002,"role":"edit"},{"id":1003,"role":"view"},{"id":4242,"role":"edit"}]}'
expect "shares: need a sign-in" 401 "$(c "$W/api/shares?server=mock-server-1")"
expect "shares: only on a server you can use" 403 "$(c -H 'X-Plex-Token: t' -H "$JSON" -X POST -d '{"server":"someone-elses","playlist":"1","title":"x","tracks":["1"]}' $W/api/shares)"
made="$(cb -H 'X-Plex-Token: t' -H "$JSON" -X POST -d "$SHARE" $W/api/shares)"
SID="$(printf '%s' "$made" | sed -n 's/^{"id":"\([a-f0-9]*\)".*/\1/p')"
contains "shares: shared with a friend who can use the server" '"members":[{"id":1002,"title":"Sam","role":"edit","joined":false}]' "$made"
contains "shares: a friend is invited" '"role":"edit","joined":false' "$(cb -H 'X-Plex-Token: t2' "$W/api/shares?server=mock-server-1")"
lacks "shares: ...without seeing who else it's shared with" '"members"' "$(cb -H 'X-Plex-Token: t2' "$W/api/shares?server=mock-server-1")"
expect "shares: someone it isn't shared with (and can't use the server) can't see it" '{"shares":[]}' "$(cb -H 'X-Plex-Token: t3' "$W/api/shares?server=mock-server-1")"
expect "shares: ...nor read it" 404 "$(c -H 'X-Plex-Token: t3' "$W/api/shares/$SID")"
expect "shares: only whoever shared it can stop sharing it" 403 "$(c -H 'X-Plex-Token: t2' -X DELETE "$W/api/shares/$SID")"
expect "shares: a friend adds it" 200 "$(c -H 'X-Plex-Token: t2' -H "$JSON" -X POST -d '{"playlist":"6000","version":1,"tracks":["120","121"],"title":"Shared test"}' "$W/api/shares/$SID/join")"
contains "shares: ...and their changes go to everyone" '"tracks":["120","121","122"]' "$(cb -H 'X-Plex-Token: t2' -H "$JSON" -X POST -d '{"tracks":["120","121","122"],"title":"Shared test"}' "$W/api/shares/$SID/sync")"
sleep 1
STORE="$(docker exec pw-web sh -c 'stat -c "%U %a" /data /data/shares.json; cat /data/shares.json')"
contains "shares: kept in /data, the service's alone" "nginx 700
nginx 600" "$STORE"
expect "the service's settings are root's alone, in a folder only root can change" "root 755
root 600
root 755" "$(docker exec pw-web stat -c "%U %a" /run/plexamp-web /run/plexamp-web/service.json /run/plexamp-web/socket)"
lacks "shares: ...without anyone's sign-in" "token" "$(printf '%s' "$STORE" | tr '[:upper:]' '[:lower:]')"
contains "shares: the log says /data isn't a volume (they'd go with the container)" "which isn't a volume" "$(docker logs pw-web 2>&1)"
# A sign-in the service hasn't seen is checked with plex.tv: a few a minute
# from each address, so made-up tokens can't keep plex.tv busy. (Last here:
# the restart below starts the counts again.)
codes="$(docker run --rm --network "$NET" --entrypoint sh "$CURL" -c \
    "curl -s -o /dev/null -H 'X-Plex-Token: t' $W/api/together/me; for i in \$(seq 1 34); do curl -s -o /dev/null -w '%{http_code} ' -H \"X-Plex-Token: made-up-\$i-token\" $W/api/together/me; done; curl -s -o /dev/null -w 'known:%{http_code}' -H 'X-Plex-Token: t' $W/api/together/me" || true)"
contains "sign-ins: made-up tokens are refused" "401" "$codes"
contains "sign-ins: ...and only so many are checked a minute from one address" "429" "$codes"
contains "sign-ins: ...while one seen before still works" "known:200" "$codes"
docker restart pw-web >/dev/null
wait_service pw-web
contains "shares: still there after a restart" '"version":2,"count":3' "$(cb -H 'X-Plex-Token: t' "$W/api/shares?server=mock-server-1")"
docker logs pw-web 2>&1 | grep -q "plexamp-web service: ready" && pass "the service started" || fail "the service started"
LOG="$(docker logs pw-web 2>&1)"
lacks "no access log by default (tokens travel in Plex addresses)" "/pms/library/sections" "$LOG"
lacks "no tokens in the log" "X-Plex-Token=t" "$LOG"

# ---------- 2. Nothing set ----------
docker run -d --name pw-web2 --network "$NET" -v "$DATA_VOLUME:/data" "$IMAGE" >/dev/null
wait_http pw-web2 http://pw-web2/
wait_service pw-web2
lacks "defaults: with a volume at /data, nothing is said about it" "which isn't a volume" "$(docker logs pw-web2 2>&1)"
expect "defaults: Play Together, your devices and shared playlists, nothing else" "window.PW_CONFIG = { together: true, devices: true, sharing: true };" "$(cb http://pw-web2/config.js | tr -d '\n')"
contains "defaults: Play on with Plex players needs PLEX_SERVER_URL (it's for the server's owner)" "Play on with Plex players needs PLEX_SERVER_URL" "$(docker logs pw-web2 2>&1)"
expect "defaults: ...so the service has no players for anyone" 404 "$(c -H 'X-Plex-Token: t' http://pw-web2/api/cast/players)"
expect "defaults: no MusicBrainz checks (MUSICBRAINZ_URL isn't set)" 404 "$(c -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d '{"items":[]}' http://pw-web2/api/musicbrainz/check)"
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
contains "OLLAMA_MODEL not set: the first model installed is used" '"model":"llama3.1:8b"' "$(cb http://pw-web3/ollama/api/status)"

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
docker run -d --name pw-web7 --network "$NET" -e PLAY_TOGETHER=false -e MUSICBRAINZ=true "$IMAGE" >/dev/null
wait_http pw-web7 http://pw-web7/
wait_service pw-web7
expect "PLAY_TOGETHER=false: not in config.js (and MUSICBRAINZ=true alone: musicbrainz.org)" 'window.PW_CONFIG = { musicbrainz: "public", devices: true, sharing: true };' "$(cb http://pw-web7/config.js | tr -d '\n')"
contains "MUSICBRAINZ=true: the log says where suggestions are checked" "checked on MusicBrainz at https://musicbrainz.org" "$(docker logs pw-web7 2>&1)"
expect "PLAY_TOGETHER=false: no sessions" 404 "$(c -H 'X-Plex-Token: t' http://pw-web7/api/together/me)"

# ---------- 7b. Playing on other Plex players off ----------
docker run -d --name pw-web8 --network "$NET" -e "$TV" -e CASTING=false -e MUSICBRAINZ=false -e MUSICBRAINZ_URL=https://musicbrainz.org -e PLAYLIST_SHARING=false "$IMAGE" >/dev/null
wait_http pw-web8 http://pw-web8/
wait_service pw-web8
expect "CASTING=false, MUSICBRAINZ=false (MUSICBRAINZ_URL set too) and PLAYLIST_SHARING=false: not in config.js" "window.PW_CONFIG = { together: true, devices: true };" "$(cb http://pw-web8/config.js | tr -d '\n')"
expect "CASTING=false: no players" 404 "$(c -H 'X-Plex-Token: t' http://pw-web8/api/cast/players)"
expect "MUSICBRAINZ=false: no checks" 404 "$(c -H 'X-Plex-Token: t' -H 'Content-Type: application/json' -X POST -d '{"items":[]}' http://pw-web8/api/musicbrainz/check)"
expect "PLAYLIST_SHARING=false: no shared playlists" 404 "$(c -H 'X-Plex-Token: t' 'http://pw-web8/api/shares?server=mock-server-1')"
expect "without PLEX_SERVER_URL, anyone signed in to Plex can use the service, on a server of their own" 200 "$(c -H 'X-Plex-Token: t3' "http://pw-web8/api/devices?device=chk-device-9&name=Check&server=mock-server-2&wait=0")"

# ---------- 7c. A Plex server reached over HTTPS at its address ----------
# A Plex server's certificate is for its plex.direct name, so at an address
# such as https://10.0.0.5:32400 the name can't match. A test authority
# stands in for the real one (NODE_EXTRA_CA_CERTS).
CERTS="$(mktemp -d)"
NAME="*.0123456789abcdef0123456789abcdef.plex.direct"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERTS/ca.key" -out "$CERTS/ca.pem" -days 2 -subj "/CN=plexamp-web test CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout "$CERTS/server.key" -out "$CERTS/server.csr" -subj "/CN=$NAME" 2>/dev/null
printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' "$NAME" >"$CERTS/ext.cnf"
openssl x509 -req -in "$CERTS/server.csr" -CA "$CERTS/ca.pem" -CAkey "$CERTS/ca.key" -CAcreateserial -out "$CERTS/server.pem" -days 2 -extfile "$CERTS/ext.cnf" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERTS/self.key" -out "$CERTS/self.pem" -days 2 -subj "/CN=plex.local" 2>/dev/null
chmod 755 "$CERTS"
chmod 644 "$CERTS"/*
docker run -d --name pw-plex-tls --network "$NET" -v "$ROOT/dev:/dev-scripts:ro" -v "$CERTS:/certs:ro" "$PY" \
    python /dev-scripts/mock-plex.py 32400 --tls 32443 /certs/server.pem /certs/server.key --quiet >/dev/null
docker run -d --name pw-plex-self --network "$NET" -v "$ROOT/dev:/dev-scripts:ro" -v "$CERTS:/certs:ro" "$PY" \
    python /dev-scripts/mock-plex.py 32400 --tls 32443 /certs/self.pem /certs/self.key --quiet >/dev/null
wait_http pw-plex-tls "http://pw-plex-tls:32400/identity"
wait_http pw-plex-self "http://pw-plex-self:32400/identity"
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
docker run -d --name pw-web9 --network "$NET" -v "$CERTS:/certs:ro" -e NODE_EXTRA_CA_CERTS=/certs/ca.pem -e DEBUG=true \
    -e PLEX_TV_URL=http://pw-plex-tls:32400 -e "PLEX_SERVER_URL=https://$(ip_of pw-plex-tls):32443" "$IMAGE" >/dev/null
docker run -d --name pw-web10 --network "$NET" \
    -e PLEX_TV_URL=http://pw-plex-self:32400 -e "PLEX_SERVER_URL=https://$(ip_of pw-plex-self):32443" "$IMAGE" >/dev/null
wait_http pw-web9 http://pw-web9/
wait_service pw-web9
wait_http pw-web10 http://pw-web10/
wait_service pw-web10
expect "HTTPS server: the proxy reaches it" 200 "$(c "http://pw-web9/pms/identity?X-Plex-Token=t")"
expect "HTTPS server: the service accepts its Plex certificate" 200 "$(c -H 'X-Plex-Token: t' http://pw-web9/api/cast/players)"
sleep 3
LOG="$(docker logs pw-web9 2>&1)"
contains "HTTPS server: the service knows which server it is" "Plex server at PLEX_SERVER_URL is mock-server-1" "$LOG"
contains "HTTPS server: the debug check reaches it" "check: Plex server (PLEX_SERVER_URL) answered with HTTP 200" "$LOG"
contains "debug: the plex.tv check is answered" "check: plex.tv (for Play Together and sign-in checks) answered with HTTP 200" "$LOG"
# A server the service can't check (a self-signed certificate) might let
# this container in without signing in, so /pms/ lets nobody through (where
# it used to let everybody).
expect "self-signed HTTPS server: refused at /pms/, as the service can't check it" 500 "$(c "http://pw-web10/pms/identity?X-Plex-Token=t")"
contains "self-signed HTTPS server: the log says why" "its certificate is self-signed" "$(docker logs pw-web10 2>&1)"
contains "at an https:// name, nginx checks the Plex server's certificate too" "proxy_ssl_verify on" "$(docker run --rm -e PLEX_SERVER_URL=https://plex.example.com:32400 --entrypoint sh "$IMAGE" -c '/docker-entrypoint.d/40-plexamp-web.sh >/dev/null 2>&1; cat /etc/nginx/conf.d/pms-proxy.inc')"
lacks "...where at an address it can't (the service checks it's Plex's own)" "proxy_ssl_verify on" "$(docker exec pw-web9 cat /etc/nginx/conf.d/pms-proxy.inc)"

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
bad "rejects an unclear PLAYLIST_SHARING" "PLAYLIST_SHARING: expected true or false" -e PLAYLIST_SHARING=sometimes
bad "rejects a DATA_DIR that isn't a full path" "DATA_DIR must be a full path" -e DATA_DIR=data
bad "rejects a DATA_DIR with .. in it" "without . or .. in it" -e DATA_DIR=/data/../etc
bad "rejects a DATA_DIR in a system folder" "DATA_DIR can't be in a system folder" -e DATA_DIR=/etc/plexamp-web
bad "rejects a DATA_DIR that isn't a folder of its own" "DATA_DIR must be a folder of its own" -e DATA_DIR=/var/lib
bad "rejects a DATA_DIR in the service's own folder" "DATA_DIR can't be in /opt/plexamp-web/server" -e DATA_DIR=/opt/plexamp-web/server/data
bad "rejects a SERVICE_USER that doesn't exist" "SERVICE_USER nobody-here doesn't exist" -e SERVICE_USER=nobody-here
off() { # name expected-message docker-run-args...: shared playlists off, the rest still up
    name="$1"
    msg="$2"
    shift 2
    docker rm -f pw-bad >/dev/null 2>&1 || true
    docker run -d --name pw-bad "$@" "$IMAGE" >/dev/null
    sleep 3
    contains "$name" "shared playlists are off: " "$(docker logs pw-bad 2>&1 || true)"
    contains "$name: says why" "$msg" "$(docker logs pw-bad 2>&1 || true)"
    expect "$name: the rest keeps running" true "$(docker inspect -f '{{.State.Running}}' pw-bad 2>/dev/null || echo false)"
    docker rm -f pw-bad >/dev/null 2>&1 || true
}
bad "rejects a RUN_DIR outside /run" "RUN_DIR must be a folder of its own in /run" -e RUN_DIR=/etc/plexamp-web
# A shares.json that's a link (the service can write in its folder, so it
# could make one): never followed, so what it leads to isn't given to the
# service.
docker volume create "$LINK_VOLUME" >/dev/null
docker run --rm -v "$LINK_VOLUME:/data" --entrypoint sh "$IMAGE" -c 'ln -s /etc/shadow /data/shares.json'
off "refuses a shares.json that's a link" "shares.json must be a file of its own (not a link" -v "$LINK_VOLUME:/data"
# A folder with other things in it isn't taken over (a home folder given
# as the volume by mistake, say).
docker run --rm -v "$LINK_VOLUME:/data" --entrypoint sh "$IMAGE" -c 'rm -f /data/shares.json && touch /data/notes.txt'
off "won't take over a folder with other files in it" "has other files in it (notes.txt)" -v "$LINK_VOLUME:/data"
expect "...and leaves it as it was" "root" "$(docker run --rm -v "$LINK_VOLUME:/data" --entrypoint stat "$IMAGE" -c %U /data/notes.txt)"
bad "rejects an unknown OLLAMA_AUTH" "OLLAMA_AUTH must be plex or off" -e OLLAMA_URL=http://x:11434 -e OLLAMA_AUTH=sometimes
bad "rejects an address with odd characters" "invalid path" -e 'OLLAMA_URL=http://x:11434/;evil'
bad "rejects an address with a line break in it" "can't have spaces or line breaks" -e "PLEX_SERVER_URL=$(printf 'http://plex.box:32400\n;evil')"
bad "rejects a model name with a line break in it (it goes into config.js)" "OLLAMA_MODEL has unexpected characters" -e OLLAMA_URL=http://x:11434 -e "OLLAMA_MODEL=$(printf 'llama3.1\n"};alert(1);//')"
bad "rejects an NGINX_LOG_PORT that isn't a port" "NGINX_LOG_PORT must be a port number" -e 'NGINX_LOG_PORT=5140,"x":1'
bad "rejects a MusicBrainz address without http://" "MUSICBRAINZ_URL must start with http://" -e MUSICBRAINZ_URL=musicbrainz.org
bad "rejects a MusicBrainz address with a password in it" "MUSICBRAINZ_URL has an invalid host or port" -e 'MUSICBRAINZ_URL=http://me:secret@mb.box:5000'
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
