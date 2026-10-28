#!/bin/sh
# Runs before nginx starts (official nginx image entrypoint hook). Turns the
# container's environment into the app's runtime config and nginx proxies,
# and starts the small service behind /api/:
#
#   PLEX_SERVER_URL     proxy one Plex server at /pms/ (WebSockets included)
#   WEBSOCKETS          how live updates reach the app: "auto" (default:
#                       WebSockets, or where they don't get through, an
#                       event stream, or polling), "on" (WebSockets only) or
#                       "off" (never). DISABLE_WEBSOCKETS=true, from before,
#                       still means off.
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
#   MUSICBRAINZ_URL     the MusicBrainz server AI playlists check their
#                       suggestions with: https://musicbrainz.org, or your
#                       own (http://192.168.1.30:5000, say). Not set: no
#                       checks. (MUSICBRAINZ, from 0.12.0: "false" still
#                       turns them off; "true" alone means musicbrainz.org.)
#   MUSICBRAINZ_ADVANCED "true" turns on the app's MusicBrainz features, with
#                       MUSICBRAINZ_URL: albums missing from artists' pages,
#                       original release years, other names for artists,
#                       genres where Plex has none, MusicBrainz's kind for
#                       albums Plex hasn't typed (Skip live tracks and demos)
#                       (off by default: they ask MusicBrainz a lot more,
#                       best with your own; nothing else needs them)
#   PLAYLIST_SHARING    "false" turns off sharing playlists with Plex friends
#                       (on by default)
#   SYNC_SETTINGS       "false" turns off keeping each Plex account's settings
#                       here, for all of its devices (on by default)
#   SYNC_MISSING_TRACKS "false" turns off keeping each Plex account's Missing
#                       tracks here, for all of its devices, and syncing
#                       everyone's into the Plex server owner's, so they can
#                       see what's missing from their server (on by default)
#   SPOTIFY_FILE_IMPORT "true" turns on Search › From Spotify with Spotify's
#                       download of your data: its playlist files, read in
#                       the browser (off by default)
#   SPOTIFY_LINK_IMPORT "true" turns on Search › From Spotify with a public
#                       playlist's link, read from Spotify's public page for
#                       it (off by default: see server/spotify.js).
#                       (SPOTIFY_IMPORT, its name before 0.22.0, still works.)
#   DATA_DIR            where shared playlists, each account's settings and
#                       Missing tracks, and what the MusicBrainz features look
#                       up, are kept (default /data: give the container a
#                       volume there). A folder of its own: it's made the
#                       service's alone.
#   DEBUG               "true" writes extra detail to the container log, with
#                       tokens and keys removed
set -eu

HTML_DIR="${HTML_DIR:-/usr/share/nginx/html}"
CONF_DIR="${CONF_DIR:-/etc/nginx/conf.d}"
RESOLV_CONF="${RESOLV_CONF:-/etc/resolv.conf}"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
# Where the service lives, and its folder in /run (changed by tests): its
# settings, and a folder for its socket (see "start the service").
SERVICE_DIR="${SERVICE_DIR:-/opt/plexamp-web/server}"
RUN_DIR="${RUN_DIR:-/run/plexamp-web}"
RUN_DIR="${RUN_DIR%/}"
SOCKET_DIR="$RUN_DIR/socket"
SERVICE_SOCKET="$SOCKET_DIR/service.sock"
NGINX_LOG_PORT="${NGINX_LOG_PORT:-5140}"
case "$NGINX_LOG_PORT" in
    "" | *[!0-9]* | 0*) echo "plexamp-web: NGINX_LOG_PORT must be a port number (got: $NGINX_LOG_PORT)" >&2 && exit 1 ;;
esac
[ "$NGINX_LOG_PORT" -le 65535 ] || { echo "plexamp-web: NGINX_LOG_PORT must be a port number (got: $NGINX_LOG_PORT)" >&2 && exit 1; }
# The app's version, for the service to say who's asking (at MusicBrainz).
APP_VERSION="$(sed -n "s/^export const APP_INFO = .*version: '\([0-9.]*\)'.*/\1/p" "$HTML_DIR/js/plex.js" 2>/dev/null | head -n 1 || true)"

fail() {
    echo "plexamp-web: $*" >&2
    exit 1
}

say() { echo "plexamp-web: $*"; }

# plain_path NAME VALUE EXAMPLE: a full path of letters, digits, ".", "_",
# "-" and "/" only (no spaces or new lines), without "." or ".." in it.
plain_path() {
    case "$2" in
        /*) ;;
        *) fail "$1 must be a full path, like $3 (got: ${2:-/})" ;;
    esac
    case "$2" in
        *[!A-Za-z0-9._/-]*) fail "$1 must be a full path, like $3, of letters, numbers, . _ - and / only" ;;
    esac
    case "$2/" in
        */./* | */../* | *//*) fail "$1 must be a plain full path, without . or .. in it (got: $2)" ;;
    esac
}

# Whether a folder is something mounted there (a volume, say).
is_mount() { awk -v d="$1" '$5 == d { found = 1 } END { exit !found }' /proc/self/mountinfo 2>/dev/null; }

# Makes DATA_DIR the service's (SERVICE_USER's, or nginx's), and no one
# else's; prints what's wrong instead, if anything is (nothing's changed).
data_dir_problem() {
    if [ -L "$DATA_DIR" ]; then
        echo "DATA_DIR ($DATA_DIR) is a link, not a folder"
        return
    fi
    if ! mkdir -p "$DATA_DIR" 2>/dev/null; then
        echo "$DATA_DIR couldn't be made"
        return
    fi
    d_user="${SERVICE_USER:-nginx}"
    if [ "$(id -u)" = 0 ] && id "$d_user" >/dev/null 2>&1; then
        if ! parent_is_roots "$DATA_DIR"; then
            echo "DATA_DIR ($DATA_DIR) is in a folder others can change: give it one only root can"
            return
        fi
        # Only a folder holding nothing but the service's own files is given
        # to it (a new or empty one, or a volume for them), never one with
        # anything else in it (a home folder given by mistake, say).
        for e in "$DATA_DIR"/* "$DATA_DIR"/.[!.]* "$DATA_DIR"/..?*; do
            [ -e "$e" ] || [ -L "$e" ] || continue
            case "${e##*/}" in
                # (and what file systems and file browsers leave around)
                shares.json | shares.json.tmp | settings.json | settings.json.tmp | missing.json | missing.json.tmp | musicbrainz.json | musicbrainz.json.tmp | lost+found | .DS_Store | ._* | @eaDir | Thumbs.db | desktop.ini) ;;
                *)
                    echo "DATA_DIR ($DATA_DIR) has other files in it (${e##*/}): give it a folder of its own (a new or empty one, or a volume)"
                    return
                    ;;
            esac
        done
        for f in "$DATA_DIR/shares.json" "$DATA_DIR/shares.json.tmp" "$DATA_DIR/settings.json" "$DATA_DIR/settings.json.tmp" "$DATA_DIR/missing.json" "$DATA_DIR/missing.json.tmp" "$DATA_DIR/musicbrainz.json" "$DATA_DIR/musicbrainz.json.tmp"; do
            if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; } || { [ -f "$f" ] && [ "$(stat -c %h "$f")" != 1 ]; }; then
                echo "$f must be a file of its own (not a link, or a folder)"
                return
            fi
        done
        rm -f "$DATA_DIR/shares.json.tmp" "$DATA_DIR/settings.json.tmp" "$DATA_DIR/missing.json.tmp" "$DATA_DIR/musicbrainz.json.tmp"
        d_group="$(id -gn "$d_user")"
        if ! chown -h "$d_user:$d_group" "$DATA_DIR"; then
            echo "$d_user can't own DATA_DIR ($DATA_DIR)"
            return
        fi
        for f in "$DATA_DIR/shares.json" "$DATA_DIR/settings.json" "$DATA_DIR/missing.json" "$DATA_DIR/musicbrainz.json"; do
            if [ -f "$f" ] && ! chown -h "$d_user:$d_group" "$f"; then
                echo "$d_user can't own $f"
                return
            fi
        done
    fi
    chmod 700 "$DATA_DIR" 2>/dev/null || true
}

# parent_is_roots FOLDER [sticky]: whether the folder FOLDER is in can be
# changed by root alone (so FOLDER can't be swapped for a link by anyone
# else): root's, and no one else can write to it. "sticky": a folder anyone
# can write to will do if it's sticky (as a tmpfs /run is), where only
# root can swap a folder of root's (see "start the service").
parent_is_roots() {
    info="$(stat -c '%u %g %a' "$(dirname "$1")" 2>/dev/null)" || return 1
    p_user="${info%% *}"
    info="${info#* }"
    p_group="${info%% *}"
    p_mode="${info#* }"
    [ "$p_user" = 0 ] || return 1
    if [ "${2:-}" = sticky ] && [ $((p_mode / 1000 % 2)) = 1 ]; then return 0; fi
    [ $((p_mode % 10 & 2)) = 0 ] && { [ $((p_mode / 10 % 10 & 2)) = 0 ] || [ "$p_group" = 0 ]; }
}

lower() { printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

# whole VALUE ERE: the whole value matches the extended regular expression
# (one line: grep alone would pass a value whose first line matched).
NL='
'
TAB="$(printf '\t')"
CR="$(printf '\r')"
whole() {
    case "$1" in *"$NL"*) return 1 ;; esac
    printf '%s\n' "$1" | grep -Eq "$2"
}

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
    case "$url" in *"$NL"* | *"$CR"* | *"$TAB"* | *' '*) fail "$var can't have spaces or line breaks in it" ;; esac
    whole "$hostport" '^([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$' ||
        fail "$var has an invalid host or port (got: $(safe_url "$url")). Addresses can't include a user name or password."
    whole "$UP_PATH" '^[A-Za-z0-9._~/-]*$' || fail "$var has an invalid path (got: $(safe_url "$url"))"
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

# ---------- shared playlists, and settings and Missing tracks that follow each account ----------

# Kept in files in DATA_DIR, the service's own (see server/shares.js,
# server/settings.js and server/missing.js).
SHARING=true
if ! truthy PLAYLIST_SHARING "${PLAYLIST_SHARING:-}" true; then SHARING=false; fi
SETTINGS_SYNC=true
if ! truthy SYNC_SETTINGS "${SYNC_SETTINGS:-}" true; then SETTINGS_SYNC=false; fi
MISSING_SYNC=true
if ! truthy SYNC_MISSING_TRACKS "${SYNC_MISSING_TRACKS:-}" true; then MISSING_SYNC=false; fi
DATA_DIR="${DATA_DIR:-/data}"
DATA_DIR="${DATA_DIR%/}"
plain_path DATA_DIR "$DATA_DIR" /data
# A folder of its own: it's given to the service (made its own, and no one
# else's), so never a system folder, or the web pages' (where it would be
# served), the service's own code or the folder for its socket. (Nor one
# with anything else in it: see below.)
case "$DATA_DIR/" in
    /bin/* | /boot/* | /dev/* | /etc/* | /lib/* | /lib32/* | /lib64/* | /libx32/* | /proc/* | /sbin/* | /sys/* | /usr/*)
        fail "DATA_DIR can't be in a system folder (got: $DATA_DIR)" ;;
    /home/ | /media/ | /mnt/ | /opt/ | /root/ | /run/ | /srv/ | /tmp/ | /var/ | /var/cache/ | /var/lib/ | /var/log/ | /var/run/ | /var/tmp/ | /var/www/)
        fail "DATA_DIR must be a folder of its own, like /data (got: $DATA_DIR)" ;;
esac
# The service's folder in /run (see "start the service"): one of its own.
plain_path RUN_DIR "$RUN_DIR" /run/plexamp-web
case "$RUN_DIR/" in
    /run/?*/) ;;
    *) fail "RUN_DIR must be a folder of its own in /run (got: $RUN_DIR)" ;;
esac
for d in "$HTML_DIR" "$SERVICE_DIR" "$RUN_DIR"; do
    d="${d%/}"
    case "$DATA_DIR/" in "$d"/*) fail "DATA_DIR can't be in $d (got: $DATA_DIR)" ;; esac
    case "$d/" in "$DATA_DIR"/*) fail "DATA_DIR can't hold $d (got: $DATA_DIR)" ;; esac
done

# ---------- MusicBrainz ----------

# Which MusicBrainz AI playlists check their suggestions with: the public
# one (musicbrainz.org, asked once a second at most, its rule) or your own.
MB_URL="${MUSICBRAINZ_URL:-}"
if [ -n "${MUSICBRAINZ:-}" ]; then
    if truthy MUSICBRAINZ "$MUSICBRAINZ"; then MB_URL="${MB_URL:-https://musicbrainz.org}"; else MB_URL=""; fi
fi
MB=false
MB_KIND=""
if [ -n "$MB_URL" ]; then
    prepare_upstream MUSICBRAINZ_URL "$MB_URL"
    MB_URL="${MB_URL%/}"
    MB=true
    case "$(lower "$UP_NAME")" in
        musicbrainz.org | *.musicbrainz.org) MB_KIND=public ;;
        *) MB_KIND=own ;;
    esac
fi

# The app's MusicBrainz features: they ask MusicBrainz about the library's
# artists and albums, so they're the host's to turn on, with MUSICBRAINZ_URL.
MB_ADV=false
if truthy MUSICBRAINZ_ADVANCED "${MUSICBRAINZ_ADVANCED:-}"; then
    if [ "$MB" = true ]; then MB_ADV=true; else say "MUSICBRAINZ_ADVANCED needs MUSICBRAINZ_URL (the MusicBrainz to ask), so the MusicBrainz features are off"; fi
fi

PLEX_TV="${PLEX_TV_URL:-https://plex.tv}"
case "$PLEX_TV" in
    http://* | https://*) ;;
    *) fail "PLEX_TV_URL must start with http:// or https:// (got: $(safe_url "$PLEX_TV"))" ;;
esac
whole "$PLEX_TV" '^https?://[]A-Za-z0-9._:[-]+(/[A-Za-z0-9._~/-]*)?$' || fail "PLEX_TV_URL isn't a plain address (got: $(safe_url "$PLEX_TV"))"

# ---------- Spotify imports ----------

# Each way is off unless it's turned on. From Spotify's download of your data
# (SPOTIFY_FILE_IMPORT): its playlist files, read in the browser; nothing goes
# to this container or to Spotify, so it doesn't need the service. From a
# public playlist's link (SPOTIFY_LINK_IMPORT; SPOTIFY_IMPORT before 0.22.0,
# which it overrides when both are set): read from Spotify's public pages,
# which Spotify's terms don't allow (see server/spotify.js). SPOTIFY_URL is
# for tests (the mock's address).
SPOTIFY_FILES=false
if truthy SPOTIFY_FILE_IMPORT "${SPOTIFY_FILE_IMPORT:-}"; then SPOTIFY_FILES=true; fi
SPOTIFY=false
if truthy SPOTIFY_IMPORT "${SPOTIFY_IMPORT:-}"; then SPOTIFY=true; fi
if [ -n "${SPOTIFY_LINK_IMPORT:-}" ]; then
    if truthy SPOTIFY_LINK_IMPORT "$SPOTIFY_LINK_IMPORT"; then SPOTIFY=true; else SPOTIFY=false; fi
fi
SPOTIFY_URL="${SPOTIFY_URL:-https://open.spotify.com}"
whole "$SPOTIFY_URL" '^https?://[]A-Za-z0-9._:[-]+$' || fail "SPOTIFY_URL isn't a plain address (got: $(safe_url "$SPOTIFY_URL"))"

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
    # At an https:// name, Plex's certificate is checked as browsers would
    # (it has to be for that name, from an authority the container trusts).
    # At an https:// network address it can't be: a Plex server's certificate
    # is for its plex.direct name, which an address never matches (the
    # service checks it's a Plex one; see server/plex.js).
    PMS_TLS=""
    case "$PMS_URL" in
        https://*)
            case "$PMS_NAME" in
                *:*) ;; # an IPv6 address
                *[!0-9.]*)
                    CA_FILE=""
                    for f in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem; do
                        if [ -f "$f" ]; then CA_FILE="$f" && break; fi
                    done
                    [ -n "$CA_FILE" ] || fail "PLEX_SERVER_URL is an https:// address, but this container has no certificate authorities to check it with"
                    PMS_TLS="proxy_ssl_verify on;
    proxy_ssl_verify_depth 4;
    proxy_ssl_trusted_certificate ${CA_FILE};"
                    ;;
            esac
            ;;
    esac
    # Shared by both locations below.
    PMS_PROXY="${PMS_ERROR_LOG}
    ${PMS_RESOLVER}
    ${PMS_TLS}
    proxy_http_version 1.1;
    proxy_set_header Host ${PMS_HOST};
    proxy_set_header Upgrade \$pw_upgrade;
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
    # Caching is decided here (see Cache-Control in nginx.conf), not by Plex,
    # and nothing from Plex sets cookies for the player's address.
    proxy_hide_header Cache-Control;
    proxy_hide_header Expires;
    proxy_hide_header Set-Cookie;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    # The app sends Plex small requests, and pictures for playlists and
    # collections (made smaller first, see detail.js: well under this).
    client_max_body_size 10m;"
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
    # How the service knows the check is nginx's (the header is cleared from
    # everything else that reaches it), and who's asking.
    proxy_set_header X-PW-Route internal;
    proxy_set_header X-Real-IP \$remote_addr;
    # The token from the request's query string, and nothing else of it
    # (what's searched for, a playlist's name: see nginx.conf). A token in
    # the X-Plex-Token header comes as it is.
    proxy_set_header X-PW-Plex-Token \$pms_auth_token;
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

# auto: nothing in config.js (the app tries a WebSocket first, and uses
# whatever gets through where one doesn't). DISABLE_WEBSOCKETS (before
# 0.25.0) is still read, and checked: "true" is off, unless WEBSOCKETS says
# otherwise.
WS_OLD=false
if truthy DISABLE_WEBSOCKETS "${DISABLE_WEBSOCKETS:-}"; then WS_OLD=true; fi
WS_MODE="$(lower "${WEBSOCKETS:-}")"
if [ -z "$WS_MODE" ]; then
    if [ "$WS_OLD" = true ]; then WS_MODE=off; else WS_MODE=auto; fi
fi
# (Not true: that could be taken for auto, and on is WebSockets only, never
# anything else, even where they don't get through.)
case "$WS_MODE" in
    auto | on) ;;
    off | false | no | 0) WS_MODE=off ;;
    true | yes | 1) fail "WEBSOCKETS must be auto, on or off (got: $WEBSOCKETS): auto, the default, uses WebSockets where they get through, and on uses nothing else" ;;
    *) fail "WEBSOCKETS must be auto, on or off (got: $WEBSOCKETS)" ;;
esac
if [ "$WS_OLD" = true ] && [ "$WS_MODE" != off ]; then
    say "DISABLE_WEBSOCKETS=true is left aside: WEBSOCKETS=$WS_MODE says otherwise"
fi
case "$WS_MODE" in
    on)
        add_config 'websockets: "on"'
        say "WebSockets only: live updates don't fall back to an event stream or polling"
        ;;
    off)
        add_config 'websockets: false'
        say "WebSockets turned off; live updates use an event stream or polling"
        ;;
esac

# ---------- Ollama ----------

# The app's requests to the shared model go through the service, which
# checks who's asking and what's asked, and uses only the model set with
# OLLAMA_MODEL (see server/ai.js).
AI_AUTH=none
AI_ON=false
if [ -n "${OLLAMA_URL:-}" ]; then
    prepare_upstream OLLAMA_URL "$OLLAMA_URL"
    MODEL="${OLLAMA_MODEL:-}"
    # (The model's name goes into the service's config, and is told only to
    # those the model is for: never in the app's config.js, which anyone
    # can read before signing in.)
    whole "$MODEL" '^[A-Za-z0-9._:/@+-]{0,200}$' || fail "OLLAMA_MODEL has unexpected characters (got: $(printf '%s' "$MODEL" | tr -c 'A-Za-z0-9._:/@+-' '?'))"
    KEY="${OLLAMA_API_KEY:-}"
    whole "$KEY" '^[A-Za-z0-9._~+/=-]*$' || fail "OLLAMA_API_KEY has unexpected characters"

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
    limit_req zone=ai_ip burst=60 nodelay;
    limit_req_status 429;
    proxy_pass http://unix:${SERVICE_SOCKET}:/api/ai/$1;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Cookie "";
    proxy_set_header X-PW-Route ai;
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
        add_config 'ai: { proxy: "ollama/" }'
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
    proxy_set_header X-PW-Route "";
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 512k;
}
CONF
    # The user the service runs as once it's started (it stops being root):
    # one that doesn't exist would leave it root.
    if [ -n "${SERVICE_USER:-}" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
        fail "SERVICE_USER $SERVICE_USER doesn't exist"
    fi
    # Shared playlists and account settings: their folder is the service's,
    # and no one else's. Nothing in it is ever followed through a link, or
    # changed through one (the service can write there, so anything there
    # could be one). What's wrong with it turns them off (and says why),
    # not the app; what the MusicBrainz features look up is then kept in
    # memory only.
    MB_KEEP=$MB_ADV
    if [ "$SHARING" = true ] || [ "$SETTINGS_SYNC" = true ] || [ "$MISSING_SYNC" = true ] || [ "$MB_ADV" = true ]; then
        why="$(data_dir_problem)"
        if [ -n "$why" ]; then
            if [ "$SHARING" = true ]; then say "shared playlists are off: $why"; fi
            if [ "$SETTINGS_SYNC" = true ]; then say "settings that follow each account are off: $why"; fi
            if [ "$MISSING_SYNC" = true ]; then say "missing tracks that follow each account are off: $why"; fi
            if [ "$MB_ADV" = true ]; then say "what the MusicBrainz features look up is kept in memory only (until the service restarts): $why"; fi
            SHARING=false
            SETTINGS_SYNC=false
            MISSING_SYNC=false
            MB_KEEP=false
        else
            # In a container, a folder that isn't a volume goes when the
            # container is replaced (an update, say), and what's in it.
            if [ -f /.dockerenv ] && ! is_mount "$DATA_DIR"; then
                kept=""
                if [ "$SHARING" = true ]; then kept="$kept, shared playlists"; fi
                if [ "$SETTINGS_SYNC" = true ]; then kept="$kept, account settings"; fi
                if [ "$MISSING_SYNC" = true ]; then kept="$kept, missing tracks"; fi
                if [ "$MB_ADV" = true ]; then kept="$kept, what the MusicBrainz features look up"; fi
                say "${kept#, }: kept in $DATA_DIR, which isn't a volume, so they'd be lost when this container is replaced (by an update, say). Give the container a volume there (see docker-compose.yml)."
            fi
        fi
    fi
    if [ "$TOGETHER" = true ]; then add_config 'together: true'; fi
    # Play on with Plex players: only for the owner of the server at
    # PLEX_SERVER_URL (without it, anyone signed in to Plex could have the
    # service send requests around this network: see server/index.js).
    if [ "$CAST" = true ] && [ -z "$PMS_URL" ]; then
        CAST=false
        say "Play on with Plex players needs PLEX_SERVER_URL (it's for the server's owner), so it's off"
    fi
    if [ "$CAST" = true ]; then add_config 'cast: true'; fi
    if [ "$MB" = true ]; then add_config "musicbrainz: \"$MB_KIND\""; fi
    if [ "$MB_ADV" = true ]; then add_config 'musicbrainzAdvanced: true'; fi
    add_config 'devices: true'
    if [ "$SHARING" = true ]; then add_config 'sharing: true'; fi
    if [ "$SETTINGS_SYNC" = true ]; then add_config 'settingsSync: true'; fi
    if [ "$MISSING_SYNC" = true ]; then add_config 'missingSync: true'; fi
    if [ "$SPOTIFY" = true ]; then add_config 'spotify: true'; fi
    if [ "$DEBUG_ON" = true ]; then add_config 'debug: true'; fi
else
    echo 'location ^~ /api/ { return 404; }' >"$API_CONF"
    if [ "$TOGETHER" = true ]; then say "Play Together needs Node.js, which isn't installed here, so it's off"; fi
    TOGETHER=false
    CAST=false
    MB=false
    MB_ADV=false
    MB_KEEP=false
    SHARING=false
    SETTINGS_SYNC=false
    MISSING_SYNC=false
    if [ "$SPOTIFY" = true ]; then say "importing from Spotify by link needs Node.js, which isn't installed here, so it's off"; fi
    SPOTIFY=false
fi
say "Play Together is $([ "$TOGETHER" = true ] && echo on || echo off)"
if [ "$SHARING" = true ]; then say "shared playlists are kept in $DATA_DIR"; fi
if [ "$SETTINGS_SYNC" = true ]; then say "settings that follow each Plex account are kept in $DATA_DIR"; fi
if [ "$MISSING_SYNC" = true ]; then say "missing tracks that follow each Plex account are kept in $DATA_DIR (everyone's, and a Plex server's owner sees them all)"; fi
if [ "$MB" = true ]; then
    say "AI playlists' suggestions are checked on MusicBrainz at $(safe_url "$MB_URL")"
fi
if [ "$MB_ADV" = true ]; then
    say "the MusicBrainz features are on: the library's artists and albums are looked up on MusicBrainz at $(safe_url "$MB_URL")$([ "$MB_KIND" = public ] && echo ', at most once a second'), and what it says is kept $([ "$MB_KEEP" = true ] && echo "in $DATA_DIR" || echo 'in memory only')"
fi
if [ "$SPOTIFY" = true ]; then say "importing from Spotify by link is on: playlists are read from Spotify's public pages"; fi
# (In the browser: no service needed.)
if [ "$SPOTIFY_FILES" = true ]; then
    add_config 'spotifyFiles: true'
    say "importing from Spotify's download of your data is on: its playlist files are read in the browser"
fi

printf 'window.PW_CONFIG = { %s };\n' "$CONFIG" >"$HTML_DIR/config.js"

# ---------- start the service ----------

if [ "$SERVICE" = true ]; then
    # Its settings are written by root, so into a folder only root can change
    # (and never through a link something else left there). Its socket goes
    # in a folder of its own inside: the service's, when it runs as
    # SERVICE_USER from the start (SERVICE_START=false: see below).
    run_group=""
    if [ "$(id -u)" = 0 ]; then
        parent_is_roots "$RUN_DIR" sticky || fail "RUN_DIR must be in a folder only root can change (got: $RUN_DIR)"
        # One that's the service's (before 0.14.0, on Proxmox, it was) is made
        # afresh: nothing left in it, or set on it, by the service stays. One
        # that's anyone else's is left alone.
        if [ -L "$RUN_DIR" ] || { [ -e "$RUN_DIR" ] && [ ! -d "$RUN_DIR" ]; }; then
            rm -f "$RUN_DIR"
        elif [ -d "$RUN_DIR" ] && [ "$(stat -c %u "$RUN_DIR")" != 0 ]; then
            [ "$(stat -c %u "$RUN_DIR")" = "$(id -u "${SERVICE_USER:-nginx}" 2>/dev/null)" ] ||
                fail "RUN_DIR ($RUN_DIR) is someone else's: give the service a folder of its own in /run"
            rm -rf "$RUN_DIR"
        fi
        mkdir -p "$RUN_DIR"
        { [ ! -L "$RUN_DIR" ] && [ "$(stat -c %u "$RUN_DIR")" = 0 ]; } || fail "RUN_DIR ($RUN_DIR) couldn't be made root's"
        if [ "${SERVICE_START:-true}" = false ] && [ -n "${SERVICE_USER:-}" ]; then
            run_group="$(id -gn "$SERVICE_USER")"
            chown -h "0:$run_group" "$RUN_DIR"
            chmod 750 "$RUN_DIR"
        else
            chown -h 0:0 "$RUN_DIR"
            chmod 755 "$RUN_DIR"
        fi
        # The settings are written afresh below (and the socket's old place,
        # before 0.14.0, goes).
        rm -f "$RUN_DIR/service.json" "$RUN_DIR/service.sock"
    else
        mkdir -p "$RUN_DIR"
    fi
    mkdir -p "$SOCKET_DIR"
    if [ -n "$run_group" ]; then
        chown -h "$SERVICE_USER:$run_group" "$SOCKET_DIR"
        chmod 750 "$SOCKET_DIR"
    fi
    json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
    (umask 077 && cat >"$RUN_DIR/service.json") <<JSON
{
  "socket": "$(json "$SERVICE_SOCKET")",
  "together": $TOGETHER,
  "cast": $CAST,
  "musicbrainz": $MB,
  "musicbrainzUrl": "$(json "$MB_URL")",
  "musicbrainzAdvanced": $MB_ADV,
  "musicbrainzKeep": $MB_KEEP,
  "version": "$(json "$APP_VERSION")",
  "devices": $SERVICE,
  "sharing": $SHARING,
  "settingsSync": $SETTINGS_SYNC,
  "missingSync": $MISSING_SYNC,
  "dataDir": "$(json "$DATA_DIR")",
  "spotify": $SPOTIFY,
  "spotifyUrl": "$(json "$SPOTIFY_URL")",
  "debug": $DEBUG_ON,
  "aiAuth": "$AI_AUTH",
  "ollamaUrl": "$([ "$AI_ON" = true ] && json "${OLLAMA_URL%/}")",
  "ollamaModel": "$([ "$AI_ON" = true ] && json "${OLLAMA_MODEL:-}")",
  "ollamaKey": "$([ "$AI_ON" = true ] && json "${OLLAMA_API_KEY:-}")",
  "plexServerUrl": "$(json "${PLEX_SERVER_URL:-}")",
  "plexTvUrl": "$(json "$PLEX_TV")",
  "nginxLogPort": $NGINX_LOG_PORT,
  "user": "$(json "${SERVICE_USER:-nginx}")"
}
JSON
    # SERVICE_START=false: systemd starts the service (on Proxmox: see
    # proxmox/install.sh), as SERVICE_USER from the start rather than as
    # root, so it can read its settings (root's still), and the folder for
    # its socket is its own.
    if [ -n "$run_group" ]; then
        chown -h "0:$run_group" "$RUN_DIR/service.json"
        chmod 640 "$RUN_DIR/service.json"
    fi
fi
# SERVICE_START=false: something else starts it (systemd, on Proxmox: see
# proxmox/install.sh).
if [ "$SERVICE" = true ] && [ "${SERVICE_START:-true}" != false ]; then
    rm -f "$SERVICE_SOCKET"
    # Restarted if it ever stops. nginx runs as PID 1, so when the container
    # stops this goes with it. UV_USE_IO_URING=0: without io_uring, giving up
    # root really gives it all up (CVE-2024-22017), and Node.js lets it.
    (
        set +e
        while :; do
            UV_USE_IO_URING=0 "$NODE_BIN" "$SERVICE_DIR/index.js" "$RUN_DIR/service.json" </dev/null
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
    say "  WEBSOCKETS=$WS_MODE${DISABLE_WEBSOCKETS:+  DISABLE_WEBSOCKETS=$DISABLE_WEBSOCKETS}"
    say "  OLLAMA_URL=$(safe_url "${OLLAMA_URL:-}")  OLLAMA_MODEL=${OLLAMA_MODEL:-}  OLLAMA_AUTH=${OLLAMA_AUTH:-plex}  OLLAMA_API_KEY: $(shown "${OLLAMA_API_KEY:-}")"
    say "  PLAY_TOGETHER=$TOGETHER  CASTING=$CAST  MUSICBRAINZ_URL=$(safe_url "$MB_URL")  MUSICBRAINZ_ADVANCED=$MB_ADV  PLAYLIST_SHARING=$SHARING  SYNC_SETTINGS=$SETTINGS_SYNC  SYNC_MISSING_TRACKS=$MISSING_SYNC  SPOTIFY_FILE_IMPORT=$SPOTIFY_FILES  SPOTIFY_LINK_IMPORT=$SPOTIFY  DATA_DIR=$DATA_DIR  service: $([ "$SERVICE" = true ] && echo running || echo 'not available')"
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
