# plexamp-web: static files served by nginx. No build step needed.
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="plexamp-web" \
      org.opencontainers.image.description="A web player for Plex music libraries" \
      org.opencontainers.image.source="https://github.com/kamakazedan/plexamp-web" \
      org.opencontainers.image.licenses="MIT"

# Optional: a Plex server address to proxy at /pms (see README).
ENV PLEX_SERVER_URL=""

RUN rm -rf /usr/share/nginx/html/* && touch /etc/nginx/conf.d/pms-proxy.inc
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 docker/40-plexamp-web.sh /docker-entrypoint.d/40-plexamp-web.sh
COPY web/ /usr/share/nginx/html/

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
