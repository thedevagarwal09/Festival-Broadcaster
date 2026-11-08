# syntax=docker/dockerfile:1
#
# Festival Broadcaster — production image.
# All state (SQLite DB, WhatsApp login keys, uploaded media) lives in the /data volume.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 1. Install dependencies -------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# git:     one Baileys dependency (libsignal) is installed straight from GitHub.
# openssl: needed by Prisma's query and schema engines.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

# The lockfile pins libsignal as git+ssh://… and there is no SSH key inside a build,
# so fetch GitHub dependencies over HTTPS instead.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && git config --global --add url."https://github.com/".insteadOf "git@github.com:"

ENV DATABASE_URL="file:/data/app.db?connection_limit=1" \
    NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate`, which needs the schema copied above.
RUN npm ci --no-audit --no-fund

# ---- 2. Build the Next.js frontend, then drop dev-only packages -------------
FROM deps AS build
COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npx prisma generate

# ---- 3. Runtime image --------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

# tini: forwards stop signals so campaigns and WhatsApp sockets shut down cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL="file:/data/app.db?connection_limit=1" \
    SESSIONS_DIR=/data/sessions \
    UPLOAD_DIR=/data/uploads \
    BAILEYS_LOG_LEVEL=silent

COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Create or update the SQLite schema in /data, then start the server.
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && exec node_modules/.bin/tsx server/index.ts"]
