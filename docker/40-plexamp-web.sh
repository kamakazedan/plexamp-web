#!/bin/sh
# Runs before nginx starts (official nginx image entrypoint hook). Turns the
# container's environment into the app's runtime config and nginx proxies,
# and starts the small service behind /api/:
#
#   PLEX_SERVER_URL     proxy one Plex server at /pms/ (WebSockets included)
#   DISABLE_WEBSOCKETS  "true": the app never opens a WebSocket
#   OLLAMA_URL          share an Ollama server's model with the app's users
#                       (through the service, at /ollama/)
#   OLLAMA_MODEL        the one model used, e.g. llama3.1:8b (default: the
#                       first one installed)
#   OLLAMA_API_KEY      sent as a bearer token, for an Ollama behind a proxy
#                       that asks for one
#   OLLAMA_AUTH         "plex" (default): only people signed in to Plex can use
#                       the shared model; "off": anyone who can open the app
#   PLAY_TOGETHER       "false" turns off Play Together (on by default)
#   CASTING             "false" turns off playing on other Plex players from
#                       the app (on by default)
#   DEBUG               "true" writes extra detail to the container log, with
#                       tokens and keys removed
set -eu

HTML_DIR="${HTML_DIR:-/usr/share/nginx/html}"
CONF_DIR="${CONF_DIR:-/etc/nginx/conf.d}"
RESOLV_CONF="${RESOLV_CONF:-/etc/resolv.conf}"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
# Where the service lives and where it puts its socket (changed by tests).
SERVICE_DIR="${SERVICE_DIR:-/opt/plexamp-web/server}"
RUN_DIR="${RUN_DIR:-/run/plexamp-web}"
SERVICE_SOCKET="$RUN_DIR/service.sock"
NGINX_LOG_PORT="${NGINX_LOG_PORT:-5140}"

fail() {
    echo "plexamp-web: $*" >&2
    exit 1
}

say() { echo "plexamp-web: $*"; }

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

# truthy NAME VALUE [DEFAULT]: is the setting on?
truthy() {
    v="$(lower "${2:-}")"
    [ -n "$v" ] || v="${3:-false}"
    case "$v" in
        1 | true | yes | on) return 0 ;;
        0 | false | no | off) return 1 ;;
        *) fail "$1: expected true or false, got: $2" ;;
    esac
}

nameserver() {
    ns="$(awk '$1 == "nameserver" { print $2; exit }' "$RESOLV_CONF" 2>/dev/null || true)"
    case "$ns" in
        '') echo 127.0.0.11 ;;
        *:*) echo "[$ns]" ;;
        *) echo "$ns" ;;
    esac
}

# Split a URL into what nginx needs. Hosts are resolved per request (so a
# container that starts later, like Ollama, doesn't stop nginx starting),
# except names in /etc/hosts (e.g. host.docker.internal via extra_hosts),
# which nginx's resolver can't see and so are swapped for their address.
#   sets UP_URL (scheme://address[:port]), UP_PATH, UP_HOST (Host header),
#   UP_NAME (TLS server name) and UP_RESOLVER (resolver line or empty)
prepare_upstream() {
    var="$1"
    url="${2%/}"
    case "$url" in
        http://* | https://*) ;;
        *) fail "$var must start with http:// or https:// (got: $(safe_url "$url"))" ;;
    esac
    scheme="${url%%://*}"
    rest="${url#*://}"
    hostport="${rest%%/*}"
    UP_PATH=""
    case "$rest" in */*) UP_PATH="/${rest#*/}" ;; esac
    UP_PATH="${UP_PATH%/}"
    printf '%s\n' "$hostport" | grep -Eq '^([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$' ||
        fail "$var has an invalid host or port (got: $(safe_url "$url")). Addresses can't include a user name or password."
    printf '%s\n' "$UP_PATH" | grep -Eq '^[A-Za-z0-9._~/-]*$' || fail "$var has an invalid path (got: $(safe_url "$url"))"
    case "$hostport" in
        \[*\]:*) host="${hostport%%]*}]"; port="${hostport##*]:}" ;;
        \[*) host="$hostport"; port="" ;;
        *:*) host="${hostport%:*}"; port="${hostport##*:}" ;;
        *) host="$hostport"; port="" ;;
    esac
    UP_HOST="$hostport"
    UP_NAME="$(printf '%s' "$host" | tr -d '[]')"
    UP_RESOLVER=""
    address="$host"
    case "$host" in
        \[*) ;;
        *[!0-9.]*)
            ip="$(awk -v h="$host" '$1 !~ /^#/ { for (i = 2; i <= NF; i++) if ($i == h) { print $1; exit } }' "$HOSTS_FILE" 2>/dev/null || true)"
            case "$ip" in
                '') UP_RESOLVER="resolver $(nameserver) valid=30s ipv6=off;" ;;
                *:*) address="[$ip]" ;;
                *) address="$ip" ;;
            esac
            ;;
    esac
    UP_URL="$scheme://$address${port:+:$port}"
}

# A URL with any user:password@ hidden, for the log.
safe_url() { printf '%s' "$1" | sed -E 's#^(([A-Za-z]+://)?)[^/@]*@#\1***@#'; }

PMS_CONF="$CONF_DIR/pms-proxy.inc"
AI_CONF="$CONF_DIR/ai-proxy.inc"
API_CONF="$CONF_DIR/api.inc"
LOG_CONF="$CONF_DIR/log.inc"

# nginx won't start if it's asked to listen on IPv6 where the kernel has it
# turned off, so drop that listener on such hosts.
if [ ! -f "${IPV6_CHECK:-/proc/net/if_inet6}" ] && [ -w "$CONF_DIR/default.conf" ]; then
    sed -i '/listen \[::\]:/d' "$CONF_DIR/default.conf"
    say "IPv6 isn't available here, so listening on IPv4 only"
fi
CONFIG=""
add_config() { CONFIG="${CONFIG:+$CONFIG, }$1"; }

# ---------- debug mode and logging ----------

DEBUG_ON=false
if truthy DEBUG "${DEBUG:-}"; then DEBUG_ON=true; fi

# Plex requests carry the sign-in token in the query string, so nginx never
# logs query strings: the access log is off, and in debug mode it shows the
# path only.
# Where it goes: the container's log, or (NGINX_ACCESS_LOG, set by the
# Proxmox install, where nginx has no log to write to) the system's.
ACCESS_LOG="${NGINX_ACCESS_LOG:-/dev/stdout}"
case "$ACCESS_LOG" in
    "" | *[!A-Za-z0-9=:,._/-]*) fail "NGINX_ACCESS_LOG can only be a path or syslog:… (got: $ACCESS_LOG)" ;;
esac
if [ "$DEBUG_ON" = true ]; then
    echo "access_log $ACCESS_LOG pw_debug;" >"$LOG_CONF"
    # nginx's errors for proxied Plex requests quote the request (and so the
    # token); in debug mode they go through the service, which removes it.
    PMS_ERROR_LOG="error_log syslog:server=127.0.0.1:${NGINX_LOG_PORT},tag=nginx,nohostname warn;"
else
    echo 'access_log off;' >"$LOG_CONF"
    PMS_ERROR_LOG="error_log stderr emerg;"
fi

# ---------- Play Together ----------

TOGETHER=true
if ! truthy PLAY_TOGETHER "${PLAY_TOGETHER:-}" true; then TOGETHER=false; fi
CAST=true
if ! truthy CASTING "${CASTING:-}" true; then CAST=false; fi

PLEX_TV="${PLEX_TV_URL:-https://plex.tv}"
case "$PLEX_TV" in
    http://* | https://*) ;;
    *) fail "PLEX_TV_URL must start with http:// or https:// (got: $PLEX_TV)" ;;
esac

# ---------- the service (/api/) ----------

NODE_BIN="${NODE_BIN:-node}"
SERVICE=false
if command -v "$NODE_BIN" >/dev/null 2>&1 && [ -f "$SERVICE_DIR/index.js" ]; then
    SERVICE=true
fi

# ---------- Plex ----------

PMS_URL=""
if [ -n "${PLEX_SERVER_URL:-}" ]; then
    prepare_upstream PLEX_SERVER_URL "$PLEX_SERVER_URL"
    PMS_URL="$UP_URL$UP_PATH"
    PMS_HOST="$UP_HOST"
    PMS_NAME="$UP_NAME"
    PMS_RESOLVER="$UP_RESOLVER"
    PMS_AUTH=""
    if [ "$SERVICE" = true ]; then
        # The service checks requests only when the Plex server lets this
        # container in without signing in (see server/index.js).
        PMS_AUTH="auth_request /_pms_auth;"
    fi
    # Shared by both locations below.
    PMS_PROXY="${PMS_ERROR_LOG}
    ${PMS_RESOLVER}
    proxy_http_version 1.1;
    proxy_set_header Host ${PMS_HOST};
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    # Set, not appended to: a browser can't pass Plex an address of its
    # choosing (Plex treats some addresses as trusted).
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Cookie \"\";
    proxy_ssl_server_name on;
    proxy_ssl_name ${PMS_NAME};
    proxy_buffering off;
    proxy_request_buffering off;
    # Caching is decided here (see Cache-Control in nginx.conf), not by Plex.
    proxy_hide_header Cache-Control;
    proxy_hide_header Expires;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    # The app only sends small requests to Plex.
    client_max_body_size 1m;"
    cat >"$PMS_CONF" <<CONF
location /pms/ {
    # Every request to Plex carries a token; refuse the rest here.
    if (\$pms_has_token = 0) { return 401; }
    ${PMS_AUTH}
    proxy_pass ${PMS_URL}\$pms_path;
    ${PMS_PROXY}
}
# The playlists and segments of a stream Plex converts are fetched from
# addresses inside the stream's session, without a token (the session's
# own id is the key), so these pass without one. They go on as nginx
# matched them (the normalised path), so a path that only looks like one of
# these can't reach anything else.
location ~ ^/pms/(audio|music)/:/transcode/universal/session/[A-Za-z0-9_-]+/[A-Za-z0-9_./-]+$ {
    proxy_pass ${PMS_URL}\$pms_uri\$is_args\$args;
    ${PMS_PROXY}
}
CONF
    if [ "$SERVICE" = true ]; then
        cat >>"$PMS_CONF" <<CONF
location = /_pms_auth {
    internal;
    ${PMS_ERROR_LOG}
    proxy_pass http://unix:${SERVICE_SOCKET}:/api/internal/pms-auth;
    proxy_method GET;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie "";
    proxy_set_header Upgrade "";
    # \$args would be the subrequest's own (empty) query string.
    proxy_set_header X-Original-URI \$request_uri;
    proxy_connect_timeout 5s;
    proxy_read_timeout 20s;
}
CONF
    fi
    add_config 'serverProxy: "pms/"'
    say "proxying /pms/ to $(safe_url "$PLEX_SERVER_URL")"
else
    : >"$PMS_CONF"
fi

# ---------- WebSockets ----------

if truthy DISABLE_WEBSOCKETS "${DISABLE_WEBSOCKETS:-}"; then
    add_config 'websockets: false'
    say "WebSockets turned off; live updates use an event stream or polling"
fi

# ---------- Ollama ----------

# The app's requests to the shared model go through the service, which
# checks who's asking and what's asked, and uses only the model set with
# OLLAMA_MODEL (see server/ai.js).
AI_AUTH=none
AI_ON=false
if [ -n "${OLLAMA_URL:-}" ]; then
    prepare_upstream OLLAMA_URL "$OLLAMA_URL"
    MODEL="${OLLAMA_MODEL:-}"
    printf '%s\n' "$MODEL" | grep -Eq '^[A-Za-z0-9._:/@+-]*$' || fail "OLLAMA_MODEL has unexpected characters (got: $MODEL)"
    KEY="${OLLAMA_API_KEY:-}"
    printf '%s\n' "$KEY" | grep -Eq '^[A-Za-z0-9._~+/=-]*$' || fail "OLLAMA_API_KEY has unexpected characters"

    case "$(lower "${OLLAMA_AUTH:-plex}")" in
        plex | on | true | yes | 1) AI_AUTH=plex ;;
        off | none | false | no | 0) AI_AUTH=off ;;
        *) fail "OLLAMA_AUTH must be plex or off (got: $OLLAMA_AUTH)" ;;
    esac
    if [ "$AI_AUTH" = plex ]; then
        if [ -n "$PMS_URL" ]; then AUTH_DESC="people with access to the Plex server"; else AUTH_DESC="anyone signed in to Plex"; fi
    else
        AUTH_DESC="anyone who can open the app"
    fi

    if [ "$SERVICE" = true ]; then
        AI_ON=true
        # Only what the app uses: chatting, and the model's name and
        # whether it's ready. Nothing else reaches the AI server.
        ai_location() { # path method
            cat <<CONF
location = /ollama/api/$1 {
    limit_except $2 { deny all; }
    limit_req zone=ai burst=20 nodelay;
    limit_req_status 429;
    proxy_pass http://unix:${SERVICE_SOCKET}:/api/ai/$1;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Cookie "";
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 4m;
}
CONF
        }
        {
            ai_location chat POST
            ai_location status GET
            ai_location tags GET
            echo 'location ^~ /ollama/ { return 404; }'
        } >"$AI_CONF"
        add_config "ai: { proxy: \"ollama/\", model: \"$MODEL\" }"
        say "sharing the AI model ${MODEL:-"(the first one installed)"} from $(safe_url "$OLLAMA_URL") with $AUTH_DESC"
        [ -n "$MODEL" ] || say "OLLAMA_MODEL isn't set, so the first model installed on the AI server is used. Set it to choose the model."
    else
        echo 'location ^~ /ollama/ { return 404; }' >"$AI_CONF"
        say "the shared AI model needs Node.js, which isn't installed here, so it's off" >&2
    fi
else
    echo 'location ^~ /ollama/ { return 404; }' >"$AI_CONF"
fi

# ---------- /api/ ----------

if [ "$SERVICE" = true ]; then
    cat >"$API_CONF" <<CONF
location ^~ /api/internal/ { return 404; }
location ^~ /api/ai/ { return 404; }
location /api/ {
    proxy_pass http://unix:${SERVICE_SOCKET};
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Cookie "";
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 512k;
}
CONF
    if [ "$TOGETHER" = true ]; then add_config 'together: true'; fi
    if [ "$CAST" = true ]; then add_config 'cast: true'; fi
    add_config 'devices: true'
    if [ "$DEBUG_ON" = true ]; then add_config 'debug: true'; fi
else
    echo 'location ^~ /api/ { return 404; }' >"$API_CONF"
    if [ "$TOGETHER" = true ]; then say "Play Together needs Node.js, which isn't installed here, so it's off"; fi
    TOGETHER=false
    CAST=false
fi
say "Play Together is $([ "$TOGETHER" = true ] && echo on || echo off)"

printf 'window.PW_CONFIG = { %s };\n' "$CONFIG" >"$HTML_DIR/config.js"

# ---------- start the service ----------

if [ "$SERVICE" = true ]; then
    mkdir -p "$RUN_DIR"
    json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
    cat >"$RUN_DIR/service.json" <<JSON
{
  "socket": "$(json "$SERVICE_SOCKET")",
  "together": $TOGETHER,
  "cast": $CAST,
  "devices": $SERVICE,
  "debug": $DEBUG_ON,
  "aiAuth": "$AI_AUTH",
  "ollamaUrl": "$([ "$AI_ON" = true ] && json "${OLLAMA_URL%/}")",
  "ollamaModel": "$([ "$AI_ON" = true ] && json "${OLLAMA_MODEL:-}")",
  "ollamaKey": "$([ "$AI_ON" = true ] && json "${OLLAMA_API_KEY:-}")",
  "plexServerUrl": "$(json "${PLEX_SERVER_URL:-}")",
  "plexTvUrl": "$(json "$PLEX_TV")",
  "nginxLogPort": $NGINX_LOG_PORT,
  "user": "${SERVICE_USER:-nginx}"
}
JSON
    chmod 600 "$RUN_DIR/service.json"
fi
# SERVICE_START=false: something else starts it (systemd, on Proxmox: see
# proxmox/install.sh).
if [ "$SERVICE" = true ] && [ "${SERVICE_START:-true}" != false ]; then
    rm -f "$SERVICE_SOCKET"
    # Restarted if it ever stops. nginx runs as PID 1, so when the container
    # stops this goes with it.
    (
        set +e
        while :; do
            "$NODE_BIN" "$SERVICE_DIR/index.js" "$RUN_DIR/service.json" </dev/null
            code=$?
            [ -f "$RUN_DIR/stop" ] && exit 0
            echo "plexamp-web: the service stopped (exit $code); restarting it in 2 seconds" >&2
            sleep 2
        done
    ) &
    echo "$!" >"$RUN_DIR/service-loop.pid"
    # Give it a moment so the first requests don't arrive before it's ready.
    for _ in $(seq 1 30); do
        [ -S "$SERVICE_SOCKET" ] && break
        sleep 0.1
    done
    [ -S "$SERVICE_SOCKET" ] || say "the service is still starting"
fi

# ---------- debug mode: show the settings and check connections ----------

if [ "$DEBUG_ON" = true ]; then
    shown() { if [ -n "${1:-}" ]; then echo "set"; else echo "not set"; fi; }
    say "debug mode is on. Settings:"
    say "  PLEX_SERVER_URL=$(safe_url "${PLEX_SERVER_URL:-}")"
    say "  DISABLE_WEBSOCKETS=${DISABLE_WEBSOCKETS:-}"
    say "  OLLAMA_URL=$(safe_url "${OLLAMA_URL:-}")  OLLAMA_MODEL=${OLLAMA_MODEL:-}  OLLAMA_AUTH=${OLLAMA_AUTH:-plex}  OLLAMA_API_KEY: $(shown "${OLLAMA_API_KEY:-}")"
    say "  PLAY_TOGETHER=$TOGETHER  CASTING=$CAST  service: $([ "$SERVICE" = true ] && echo running || echo 'not available')"
    say "  config.js: $(cat "$HTML_DIR/config.js")"
    # Checked in the background so a slow or missing server doesn't hold up
    # start-up. Only status codes are printed.
    check() { # name url [wget options]
        name="$1"
        url="$2"
        shift 2
        code="$(wget -q -S -O /dev/null -T 8 "$@" "$url" 2>&1 | awk '{ for (i = 1; i < NF; i++) if ($i ~ /^HTTP\/[0-9.]+$/ && $(i + 1) ~ /^[0-9][0-9][0-9]$/) c = $(i + 1) } END { print c }')"
        if [ -n "$code" ]; then
            say "check: $name answered with HTTP $code"
        else
            say "check: couldn't reach $name ($(safe_url "$url")) from inside the container. Check the address, and that the container can reach it (network, firewall, DNS)."
        fi
    }
    (
        sleep 1
        if [ -n "${PLEX_SERVER_URL:-}" ]; then
            # As the proxy does: a Plex server's certificate is for its
            # plex.direct name, so at a network address it can't match.
            check "Plex server (PLEX_SERVER_URL)" "${PLEX_SERVER_URL%/}/identity" --no-check-certificate
        fi
        if [ -n "${OLLAMA_URL:-}" ]; then
            check "Ollama (OLLAMA_URL)" "${OLLAMA_URL%/}/api/version"
        fi
        if [ "$TOGETHER" = true ] || [ "$AI_AUTH" = plex ]; then
            check "plex.tv (for Play Together and sign-in checks)" "${PLEX_TV%/}/api/v2/ping?X-Plex-Client-Identifier=plexamp-web-check"
        fi
    ) &
fi
