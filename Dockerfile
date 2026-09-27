# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install all deps, compile TypeScript, then drop dev deps so the
# runtime image never needs a compiler.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# better-sqlite3 is a native addon. These are only used if no prebuilt binary
# matches this platform; they never reach the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Runtime stage: production deps + compiled output only. Runs as non-root.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    WORK_ROOT=/app/work \
    DB_PATH=/app/data/bridge.db
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/work /app/data && chown -R node:node /app
USER node

# Secrets are injected at run time, never baked in:
#   docker run --env-file .env tg-agent-bridge
CMD ["node", "dist/index.js"]
