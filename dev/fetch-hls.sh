#!/bin/sh
# Optional, for running the app outside Docker: puts hls.js (the version the
# image bundles, see the Dockerfile) in web/vendor/. Only needed to play
# tracks your server converts, in browsers without built-in HLS. Needs npm.
# The download has to match the checksum the Dockerfile keeps for it.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^ARG HLS_JS_VERSION=//p' "$ROOT/Dockerfile")"
INTEGRITY="$(sed -n 's/^ARG HLS_JS_INTEGRITY=//p' "$ROOT/Dockerfile")"
if [ -z "$VERSION" ] || [ -z "$INTEGRITY" ]; then
    echo "The Dockerfile doesn't say which hls.js to use, and its checksum" >&2
    exit 1
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm pack --silent "hls.js@$VERSION" >/dev/null
node -e 'const got = "sha512-" + require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"); if (got !== process.argv[2]) { console.error("hls.js " + process.argv[3] + " is " + got + ", not the " + process.argv[2] + " the Dockerfile has"); process.exit(1); }' \
    "hls.js-$VERSION.tgz" "$INTEGRITY" "$VERSION"
tar -xzf "hls.js-$VERSION.tgz"
mkdir -p "$ROOT/web/vendor"
cp package/dist/hls.min.js "$ROOT/web/vendor/hls.min.js"
cp package/LICENSE "$ROOT/web/vendor/hls.js-LICENSE.txt"
echo "$VERSION" >"$ROOT/web/vendor/hls.js-VERSION.txt"
echo "hls.js $VERSION is in web/vendor/ (it matched its checksum)"
