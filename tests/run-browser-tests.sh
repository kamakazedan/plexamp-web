#!/bin/sh
# Runs tests/browser_test.py in headless Chromium against the built image and
# the mock Plex and Ollama servers in dev/. Used by CI; needs Docker, and
# Python with Playwright:
#
#   pip install playwright && python -m playwright install --with-deps chromium
#   docker build -t plexamp-web:test . && sh tests/run-browser-tests.sh plexamp-web:test [screenshot-dir]
#
# Four copies of the app run: one with a shared AI model and WebSockets
# allowed, checking on the mock's MusicBrainz (port 8081), one with DISABLE_WEBSOCKETS=true and no shared model
# (port 8082), one with DEBUG=true and a shared model that won't take
# "think" (port 8083), and one on a second mock server with a big library,
# for the memory tests (port 8084). All reach
# their mock Plex server through their /pms proxy, and their service uses
# the mock for plex.tv too (its accounts are needed for Play Together).
set -eu

IMAGE="${1:-plexamp-web:test}"
OUT="${2:-screenshots}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NET="pw-browser-$$"
PY="python:3.12-alpine"

cleanup() {
    docker rm -f pwb-plex pwb-plex-big pwb-ollama pwb-ollama2 pwb-web pwb-web2 pwb-web3 pwb-web4 >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

mock() { # name port script args...
    name="$1"
    port="$2"
    shift 2
    docker run -d --name "$name" --network "$NET" -p "127.0.0.1:$port:$port" -v "$ROOT/dev:/dev-scripts:ro" "$PY" \
        python "/dev-scripts/$@" >/dev/null
}

# In GitHub Actions, a problem also becomes an annotation on the run's
# summary page (and readable through the API).
annotate() { # message
    echo "$1"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
        echo "::error title=Browser tests::$(printf '%s' "$1" | tr '\r\n' '  ' | sed 's/%/%25/g' | cut -c1-900)"
    fi
}

wait_for() { # url
    for _ in $(seq 1 60); do
        curl -sf -o /dev/null "$1" && return 0
        sleep 0.5
    done
    annotate "timed out waiting for $1"
    return 1
}

docker network create "$NET" >/dev/null
mock pwb-plex 32400 mock-plex.py 32400 --quiet
mock pwb-plex-big 32401 mock-plex.py 32401 --big 3000 --quiet
mock pwb-ollama 11434 mock-ollama.py --port 11434 --quiet
mock pwb-ollama2 11435 mock-ollama.py --port 11435 --reject-think --quiet
TV=PLEX_TV_URL=http://pwb-plex:32400
# Every test signs in as the same few accounts, so settings that follow an
# account would carry one section's changes into the next: only the
# DEBUG=true app keeps them (its sections test that).
docker run -d --name pwb-web --network "$NET" -p 127.0.0.1:8081:80 -e "$TV" -e SYNC_SETTINGS=false \
    -e PLEX_SERVER_URL=http://pwb-plex:32400 -e OLLAMA_URL=http://pwb-ollama:11434 -e OLLAMA_MODEL=llama3.1:8b \
    -e MUSICBRAINZ_URL=http://pwb-plex:32400 -e SPOTIFY_IMPORT=true -e SPOTIFY_URL=http://pwb-plex:32400 "$IMAGE" >/dev/null
docker run -d --name pwb-web2 --network "$NET" -p 127.0.0.1:8082:80 -e "$TV" -e SYNC_SETTINGS=false \
    -e PLEX_SERVER_URL=http://pwb-plex:32400 -e DISABLE_WEBSOCKETS=true "$IMAGE" >/dev/null
docker run -d --name pwb-web3 --network "$NET" -p 127.0.0.1:8083:80 -e "$TV" \
    -e PLEX_SERVER_URL=http://pwb-plex:32400 -e DEBUG=true \
    -e OLLAMA_URL=http://pwb-ollama2:11435 -e OLLAMA_MODEL=llama3.1:8b "$IMAGE" >/dev/null
docker run -d --name pwb-web4 --network "$NET" -p 127.0.0.1:8084:80 -e PLEX_TV_URL=http://pwb-plex-big:32401 -e SYNC_SETTINGS=false \
    -e PLEX_SERVER_URL=http://pwb-plex-big:32401 "$IMAGE" >/dev/null

for url in "http://127.0.0.1:32400/identity" "http://127.0.0.1:32401/identity" http://127.0.0.1:11434/api/version \
    http://127.0.0.1:11435/api/version http://127.0.0.1:8081/api/health http://127.0.0.1:8082/api/health \
    http://127.0.0.1:8083/api/health http://127.0.0.1:8084/api/health; do
    wait_for "$url"
done

status=0
APP_URL=http://127.0.0.1:8081/ APP_URL_NOWS=http://127.0.0.1:8082/ APP_URL_DEBUG=http://127.0.0.1:8083/ \
    MOCK_PLEX=http://127.0.0.1:32400 PLEX_LOGIN_URL= \
    APP_URL_BIG=http://127.0.0.1:8084/ MOCK_PLEX_BIG=http://127.0.0.1:32401 \
    OLLAMA_DIRECT=http://127.0.0.1:11434 OLLAMA_NOTHINK=http://127.0.0.1:11435 \
    python3 "$ROOT/tests/browser_test.py" "$OUT" || status=$?

# What the debug-mode container logged while the browser used it.
log="$(docker logs pwb-web3 2>&1)"
case "$log" in
    *"plexamp-web browser"*"answered 404"*) echo "PASS debug: browser problems are in the container log" ;;
    *) annotate "FAIL debug: browser problems are in the container log"; status=1 ;;
esac
if printf '%s' "$log" | grep -Eq 'X-Plex-Token=t2?([^A-Za-z0-9_.~-]|$)'; then
    annotate "FAIL debug: a token reached the container log"
    status=1
else
    echo "PASS debug: no tokens in the container log"
fi

if [ "$status" -ne 0 ]; then
    for n in pwb-web pwb-web3; do
        echo "--- $n log"
        docker logs "$n" 2>&1 | tail -40
    done
fi
exit "$status"
