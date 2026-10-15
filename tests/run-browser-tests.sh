#!/bin/sh
# Runs tests/browser_test.py in headless Chromium against the built image and
# the mock Plex and Ollama servers in dev/. Used by CI; needs Docker, and
# Python with Playwright:
#
#   pip install playwright && python -m playwright install --with-deps chromium
#   docker build -t plexamp-web:test . && sh tests/run-browser-tests.sh plexamp-web:test [screenshot-dir]
#
# Two copies of the app run: one with a shared AI model and WebSockets
# allowed (port 8081), one with DISABLE_WEBSOCKETS=true and no shared model
# (port 8082). Both reach the mock Plex server through their /pms proxy.
set -eu

IMAGE="${1:-plexamp-web:test}"
OUT="${2:-screenshots}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NET="pw-browser-$$"
PY="python:3.12-alpine"

cleanup() {
    docker rm -f pwb-plex pwb-ollama pwb-ollama2 pwb-web pwb-web2 >/dev/null 2>&1 || true
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

wait_for() { # url
    for _ in $(seq 1 60); do
        curl -s -o /dev/null "$1" && return 0
        sleep 0.5
    done
    echo "timed out waiting for $1"
    return 1
}

docker network create "$NET" >/dev/null
mock pwb-plex 32400 mock-plex.py 32400 --quiet
mock pwb-ollama 11434 mock-ollama.py --port 11434 --quiet
mock pwb-ollama2 11435 mock-ollama.py --port 11435 --reject-think --quiet
docker run -d --name pwb-web --network "$NET" -p 127.0.0.1:8081:80 \
    -e PLEX_SERVER_URL=http://pwb-plex:32400 -e OLLAMA_URL=http://pwb-ollama:11434 -e OLLAMA_MODEL=llama3.1:8b "$IMAGE" >/dev/null
docker run -d --name pwb-web2 --network "$NET" -p 127.0.0.1:8082:80 \
    -e PLEX_SERVER_URL=http://pwb-plex:32400 -e DISABLE_WEBSOCKETS=true "$IMAGE" >/dev/null

for url in "http://127.0.0.1:32400/identity?X-Plex-Token=t" http://127.0.0.1:11434/api/version \
    http://127.0.0.1:11435/api/version http://127.0.0.1:8081/ http://127.0.0.1:8082/; do
    wait_for "$url"
done

status=0
APP_URL=http://127.0.0.1:8081/ APP_URL_NOWS=http://127.0.0.1:8082/ MOCK_PLEX=http://127.0.0.1:32400 PLEX_LOGIN_URL= \
    OLLAMA_DIRECT=http://127.0.0.1:11434 OLLAMA_NOTHINK=http://127.0.0.1:11435 \
    python3 "$ROOT/tests/browser_test.py" "$OUT" || status=$?
if [ "$status" -ne 0 ]; then
    echo "--- pwb-web log"
    docker logs pwb-web 2>&1 | tail -40
fi
exit "$status"
