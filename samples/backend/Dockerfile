# ══════════════════════════════════════════════════════════════════════════
#  Acme API
#
#  Built from the REPOSITORY ROOT, not from backend/:
#
#      docker build -f backend/Dockerfile .
#
#  because the rules engine and the date helpers in shared/ are the same files
#  the browser loads. Copying them rather than duplicating them is what keeps
#  one implementation of the invariants.
# ══════════════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim

WORKDIR /app

# Dependencies first, so a source change does not reinstall them. `--omit=dev`
# leaves out sqlite3 — production is MySQL, and its native build chain has no
# business in the image.
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./
COPY shared/ ../shared/

ENV NODE_ENV=production \
    PORT=3000

# Non-root. The API writes nothing to disk in production — uploads live in the
# database and logs go to stdout — so it needs no writable volume.
RUN useradd --create-home --shell /usr/sbin/nologin app \
 && chown -R app:app /app /shared
USER app

EXPOSE 3000

# The orchestrator's own probe. bin/www does not listen until the schema is
# applied, so "connection refused" means genuinely not ready rather than
# ready-but-broken.
HEALTHCHECK --interval=15s --timeout=4s --start-period=40s --retries=4 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "bin/www"]
