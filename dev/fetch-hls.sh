#!/bin/sh
# Optional, for running the app outside Docker: puts hls.js (the version the
# image bundles, see the Dockerfile) in web/vendor/. Only needed to play
# tracks your server converts, in browsers without built-in HLS. Needs npm.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/^ARG HLS_JS_VERSION=//p' "$ROOT/Dockerfile")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm pack --silent "hls.js@$VERSION" >/dev/null
tar -xzf "hls.js-$VERSION.tgz"
mkdir -p "$ROOT/web/vendor"
cp package/dist/hls.min.js "$ROOT/web/vendor/hls.min.js"
cp package/LICENSE "$ROOT/web/vendor/hls.js-LICENSE.txt"
echo "$VERSION" >"$ROOT/web/vendor/hls.js-VERSION.txt"
echo "hls.js $VERSION is in web/vendor/"
