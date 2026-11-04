# emoji-tray — a static site, served by unprivileged nginx.
#
# The image contains the app and the emoji data. Your own tray/combos go in
# a config.json mounted at /usr/share/nginx/html/config.json; without one the
# shipped config.default.json is used.
#
# nginx-unprivileged runs as UID 101 and listens on 8080, so the container
# needs no root and no capabilities.
FROM nginxinc/nginx-unprivileged:1.31.2-alpine

ARG VERSION=dev
LABEL org.opencontainers.image.title="emoji-tray" \
      org.opencontainers.image.description="A fast, private emoji picker: click to copy, skin tones, favorites, combos, search in English, German and Russian." \
      org.opencontainers.image.source="https://github.com/headphonebear/emoji-tray" \
      org.opencontainers.image.licenses="MIT AND Unicode-3.0" \
      org.opencontainers.image.version="${VERSION}"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=root:root web/ /usr/share/nginx/html/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
