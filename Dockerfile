# plexamp-web: the web app served by nginx, plus a small Node.js service for
# Play Together, Play on, shared playlists, the shared AI model and sign-in
# checks. No build step for the app itself.

# hls.js (plays music your server converts, in browsers without built-in
# HLS) is bundled into the image at a pinned version, so the app never loads
# code from a CDN. npm checks the download against the registry's checksum.
FROM --platform=$BUILDPLATFORM node:22-alpine AS vendor
ARG HLS_JS_VERSION=1.6.19
WORKDIR /vendor
RUN npm pack --silent "hls.js@${HLS_JS_VERSION}" \
    && tar -xzf "hls.js-${HLS_JS_VERSION}.tgz" \
    && mkdir -p out \
    && cp package/dist/hls.min.js out/hls.min.js \
    && cp package/LICENSE out/hls.js-LICENSE.txt \
    && echo "${HLS_JS_VERSION}" >out/hls.js-VERSION.txt

# nginx's stable branch (1.30), which gets its security fixes: the image is
# rebuilt with each release, and Alpine's own fixes since are taken too.
FROM nginx:1.30-alpine

LABEL org.opencontainers.image.title="plexamp-web" \
      org.opencontainers.image.description="A web player for Plex music libraries" \
      org.opencontainers.image.source="https://github.com/kamakazedan/plexamp-web" \
      org.opencontainers.image.licenses="MIT"

RUN apk upgrade --no-cache && apk add --no-cache nodejs

# All optional; see docs/configuration.md.
ENV PLEX_SERVER_URL="" \
    DISABLE_WEBSOCKETS="" \
    OLLAMA_URL="" \
    OLLAMA_MODEL="" \
    OLLAMA_API_KEY="" \
    OLLAMA_AUTH="plex" \
    PLAY_TOGETHER="true" \
    CASTING="true" \
    PLAYLIST_SHARING="true" \
    DEBUG=""

RUN rm -rf /usr/share/nginx/html/* \
    && touch /etc/nginx/conf.d/pms-proxy.inc /etc/nginx/conf.d/ai-proxy.inc /etc/nginx/conf.d/api.inc /etc/nginx/conf.d/log.inc
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 docker/40-plexamp-web.sh /docker-entrypoint.d/40-plexamp-web.sh
COPY server/ /opt/plexamp-web/server/
COPY web/ /usr/share/nginx/html/
COPY --from=vendor /vendor/out/ /usr/share/nginx/html/vendor/

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
