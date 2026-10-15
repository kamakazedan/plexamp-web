#!/bin/sh
# Runs before nginx starts (official nginx image entrypoint hook).
# Writes the app's runtime config and, when PLEX_SERVER_URL is set, a
# reverse proxy to that server at /pms/.
set -eu

HTML_DIR="${HTML_DIR:-/usr/share/nginx/html}"
PROXY_CONF="${PROXY_CONF:-/etc/nginx/conf.d/pms-proxy.inc}"
url="${PLEX_SERVER_URL:-}"

if [ -n "$url" ]; then
    case "$url" in
        http://*|https://*) ;;
        *) echo "plexamp-web: PLEX_SERVER_URL must start with http:// or https:// (got: $url)" >&2; exit 1 ;;
    esac
    url="${url%/}"
    cat > "$PROXY_CONF" <<CONF
location /pms/ {
    proxy_pass ${url}/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_ssl_server_name on;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 0;
}
CONF
    printf 'window.PW_CONFIG = { serverProxy: "pms/" };\n' > "$HTML_DIR/config.js"
    echo "plexamp-web: proxying /pms/ to $url"
else
    : > "$PROXY_CONF"
    printf 'window.PW_CONFIG = {};\n' > "$HTML_DIR/config.js"
fi
