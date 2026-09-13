# ══════════════════════════════════════════════════════════════════════════
#  Acme web
#
#  Built from the REPOSITORY ROOT:
#
#      docker build -f frontend/Dockerfile .
#
#  The app has no build step and no dependencies — it IS the files it serves.
#  What this image adds is the mappings tools/server.js applies:
#
#      /            frontend/     the app shell
#      /shared/     shared/       the rules engine, shared with the API
#      /docs/       docs/         the user manual PDF, and only that
#      /v1/api/     proxied to the API
#
#  The proxy is why the session cookie simply works: one origin for the page
#  and the API means SameSite=Lax is enough and there is no CORS preflight on
#  every request. Serving them from two origins is possible and costs you
#  CORS, a named origin list, and a third-party-cookie policy to fall foul of.
# ══════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim

WORKDIR /app

COPY frontend/ ./frontend/
COPY shared/   ./shared/
COPY docs/     ./docs/
COPY tools/server.js ./tools/server.js

ENV PORT=3010 \
    HOST=0.0.0.0 \
    API_ORIGIN=http://api:3000

RUN useradd --create-home --shell /usr/sbin/nologin web && chown -R web:web /app
USER web

EXPOSE 3010

HEALTHCHECK --interval=15s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3010)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["sh", "-c", "node tools/server.js ${PORT}"]
