#!/bin/sh
# Runs before nginx starts (official nginx image entrypoint hook). Turns the
# container's environment into the app's runtime config and nginx proxies:
#
#   PLEX_SERVER_URL     proxy one Plex server at /pms/ (WebSockets included)
#   DISABLE_WEBSOCKETS  "true": the app never opens a WebSocket
#   OLLAMA_URL          proxy an Ollama server at /ollama/ as a shared AI model
#   OLLAMA_MODEL        the shared model's default, e.g. llama3.1:8b
#   OLLAMA_API_KEY      sent as a bearer token, for an Ollama behind a proxy
#                       that asks for one
#   OLLAMA_AUTH         "plex" (default): only people signed in to Plex can use
#                       the shared model; "off": anyone who can open the app
set -eu

HTML_DIR="${HTML_DIR:-/usr/share/nginx/html}"
CONF_DIR="${CONF_DIR:-/etc/nginx/conf.d}"
RESOLV_CONF="${RESOLV_CONF:-/etc/resolv.conf}"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"

fail() {
    echo "plexamp-web: $*" >&2
    exit 1
}

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

truthy() {
    case "$(lower "${1:-}")" in
        1 | true | yes | on) return 0 ;;
        '' | 0 | false | no | off) return 1 ;;
        *) fail "expected true or false, got: $1" ;;
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
        *) fail "$var must start with http:// or https:// (got: $url)" ;;
    esac
    scheme="${url%%://*}"
    rest="${url#*://}"
    hostport="${rest%%/*}"
    UP_PATH=""
    case "$rest" in */*) UP_PATH="/${rest#*/}" ;; esac
    UP_PATH="${UP_PATH%/}"
    printf '%s\n' "$hostport" | grep -Eq '^([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$' ||
        fail "$var has an invalid host or port (got: $url)"
    printf '%s\n' "$UP_PATH" | grep -Eq '^[A-Za-z0-9._~/-]*$' || fail "$var has an invalid path (got: $url)"
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

PMS_CONF="$CONF_DIR/pms-proxy.inc"
AI_CONF="$CONF_DIR/ai-proxy.inc"

# nginx won't start if it's asked to listen on IPv6 where the kernel has it
# turned off, so drop that listener on such hosts.
if [ ! -f "${IPV6_CHECK:-/proc/net/if_inet6}" ] && [ -w "$CONF_DIR/default.conf" ]; then
    sed -i '/listen \[::\]:/d' "$CONF_DIR/default.conf"
    echo "plexamp-web: IPv6 isn't available here, so listening on IPv4 only"
fi
CONFIG=""
add_config() { CONFIG="${CONFIG:+$CONFIG, }$1"; }

# ---------- Plex ----------

PMS_URL=""
if [ -n "${PLEX_SERVER_URL:-}" ]; then
    prepare_upstream PLEX_SERVER_URL "$PLEX_SERVER_URL"
    PMS_URL="$UP_URL$UP_PATH"
    PMS_HOST="$UP_HOST"
    PMS_NAME="$UP_NAME"
    PMS_RESOLVER="$UP_RESOLVER"
    cat >"$PMS_CONF" <<CONF
location /pms/ {
    ${PMS_RESOLVER}
    proxy_pass ${PMS_URL}\$pms_path;
    proxy_http_version 1.1;
    proxy_set_header Host ${PMS_HOST};
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_ssl_server_name on;
    proxy_ssl_name ${PMS_NAME};
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    client_max_body_size 0;
}
CONF
    add_config 'serverProxy: "pms/"'
    echo "plexamp-web: proxying /pms/ to $PLEX_SERVER_URL"
else
    : >"$PMS_CONF"
fi

# ---------- WebSockets ----------

if truthy "${DISABLE_WEBSOCKETS:-}"; then
    add_config 'websockets: false'
    echo "plexamp-web: WebSockets turned off; live updates use an event stream or polling"
fi

# ---------- Ollama ----------

if [ -n "${OLLAMA_URL:-}" ]; then
    prepare_upstream OLLAMA_URL "$OLLAMA_URL"
    AI_URL="$UP_URL$UP_PATH"
    AI_HOST="$UP_HOST"
    AI_NAME="$UP_NAME"
    AI_RESOLVER="$UP_RESOLVER"
    MODEL="${OLLAMA_MODEL:-}"
    printf '%s\n' "$MODEL" | grep -Eq '^[A-Za-z0-9._:/@+-]*$' || fail "OLLAMA_MODEL has unexpected characters (got: $MODEL)"
    KEY="${OLLAMA_API_KEY:-}"
    printf '%s\n' "$KEY" | grep -Eq '^[A-Za-z0-9._~+/=-]*$' || fail "OLLAMA_API_KEY has unexpected characters"
    AUTHZ='""'
    if [ -n "$KEY" ]; then AUTHZ="\"Bearer $KEY\""; fi

    case "$(lower "${OLLAMA_AUTH:-plex}")" in
        plex | on | true | yes | 1) AUTH=plex ;;
        off | none | false | no | 0) AUTH=off ;;
        *) fail "OLLAMA_AUTH must be plex or off (got: $OLLAMA_AUTH)" ;;
    esac

    AUTH_LINE=""
    AUTH_TLS=""
    if [ "$AUTH" = plex ]; then
        AUTH_LINE="auth_request /_ai_auth;"
        if [ -n "$PMS_URL" ]; then
            # Allowed: anyone whose token works on the Plex server above.
            AUTH_DESC="people with access to the Plex server"
            AUTH_TARGET="${PMS_URL}/library/sections?X-Plex-Container-Size=0"
            AUTH_TOKEN='$ai_server_token'
            AUTH_HOST="$PMS_HOST"
            AUTH_NAME="$PMS_NAME"
            AUTH_RESOLVER="$PMS_RESOLVER"
        else
            # Allowed: anyone signed in to a Plex account.
            AUTH_DESC="anyone signed in to Plex"
            AUTH_TARGET="https://plex.tv/api/v2/user"
            AUTH_TOKEN='$http_x_plex_token'
            AUTH_HOST="plex.tv"
            AUTH_NAME="plex.tv"
            AUTH_RESOLVER="resolver $(nameserver) valid=300s ipv6=off;"
            AUTH_TLS="proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_verify_depth 4;"
        fi
    else
        AUTH_DESC="anyone who can open the app"
    fi

    # Only the endpoints the app uses are passed on: models can't be pulled,
    # pushed, copied or deleted through this proxy.
    ai_location() { # path method extra-directives
        cat <<CONF
location = /ollama/api/$1 {
    limit_except $2 { deny all; }
    ${AUTH_LINE}
    limit_req zone=ai burst=20 nodelay;
    limit_req_status 429;
    ${AI_RESOLVER}
    set \$ai_upstream "${AI_URL}";
    proxy_pass \$ai_upstream/api/$1;
    proxy_http_version 1.1;
    proxy_set_header Host ${AI_HOST};
    proxy_set_header Connection "";
    proxy_set_header Authorization ${AUTHZ};
    proxy_set_header X-Plex-Token "";
    proxy_set_header X-Plex-Server-Token "";
    proxy_set_header Origin "";
    proxy_ssl_server_name on;
    proxy_ssl_name ${AI_NAME};
$3
}
CONF
    }

    {
        ai_location version GET ''
        ai_location tags GET ''
        ai_location chat POST '    client_max_body_size 4m;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;'
        echo 'location ^~ /ollama/ { return 404; }'
        if [ "$AUTH" = plex ]; then
            cat <<CONF
location = /_ai_auth {
    internal;
    ${AUTH_RESOLVER}
    set \$ai_auth_target "${AUTH_TARGET}";
    proxy_pass \$ai_auth_target;
    # Subrequests inherit the original method (POST for chat); the check is a GET.
    proxy_method GET;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Origin "";
    proxy_set_header Cookie "";
    proxy_set_header Host ${AUTH_HOST};
    proxy_set_header Accept "application/json";
    proxy_set_header X-Plex-Token ${AUTH_TOKEN};
    proxy_set_header X-Plex-Product "plexamp-web";
    proxy_set_header X-Plex-Client-Identifier "plexamp-web-ai-proxy";
    proxy_ssl_server_name on;
    proxy_ssl_name ${AUTH_NAME};
    ${AUTH_TLS}
    proxy_connect_timeout 10s;
    proxy_read_timeout 15s;
}
CONF
        fi
    } >"$AI_CONF"
    add_config "ai: { proxy: \"ollama/\", model: \"$MODEL\" }"
    echo "plexamp-web: proxying /ollama/ to $OLLAMA_URL (model: ${MODEL:-not set}; allowed: $AUTH_DESC)"
else
    echo 'location ^~ /ollama/ { return 404; }' >"$AI_CONF"
fi

printf 'window.PW_CONFIG = { %s };\n' "$CONFIG" >"$HTML_DIR/config.js"
