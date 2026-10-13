# syntax=docker/dockerfile:1
# Production images (B091): one build, three runtime targets.
#
#   docker build -f infra/deploy/Dockerfile --target api    -t centcom-api:TAG .
#   docker build -f infra/deploy/Dockerfile --target relay  -t centcom-relay:TAG .
#   docker build -f infra/deploy/Dockerfile --target worker -t centcom-worker:TAG .
#
# The worker is the API's code started with `--worker` (apps/api/src/worker.ts), so the api and
# worker images hold the same files and differ only in their default command. The migration CLI
# (`centcom-db`) is in the api and worker images and runs as a one-shot (see migrate-safe.sh).
# Every image runs as the unprivileged `node` user (UID 1000) and holds no compiler, no
# dev dependency and no secret: configuration arrives through the environment at start.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV CI=true
RUN npm install --global pnpm@12.9.1
WORKDIR /repo
COPY . .
# Lifecycle scripts stay off (pnpm-workspace.yaml: ignoreScripts), as everywhere in this repo.
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b apps/api apps/relay \
 && pnpm --filter @centcom/contracts run build:assets
# `deploy` writes a folder with the package, its production dependencies and the built workspace
# packages (contracts, core, db with its migrations, storage, worker), and nothing else.
RUN pnpm --filter @centcom/api --prod deploy --legacy /out/api \
 && pnpm --filter @centcom/relay --prod deploy --legacy /out/relay

FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production
# tini is PID 1 so that SIGTERM reaches node and zombies are reaped.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime-base AS api
ARG SERVICE_VERSION=unknown
ENV SERVICE_VERSION=${SERVICE_VERSION} SERVICE_NAME=api HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /out/api/ /app/
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

# The same files as `api`; the process runs the BullMQ jobs and listens on no port.
FROM runtime-base AS worker
ARG SERVICE_VERSION=unknown
ENV SERVICE_VERSION=${SERVICE_VERSION} SERVICE_NAME=worker
COPY --from=build --chown=node:node /out/api/ /app/
CMD ["node", "dist/main.js", "--worker"]

FROM runtime-base AS relay
ARG SERVICE_VERSION=unknown
ENV SERVICE_VERSION=${SERVICE_VERSION} SERVICE_NAME=relay HOST=0.0.0.0 RELAY_PORT=8080
COPY --from=build --chown=node:node /out/relay/ /app/
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The relay holds WebSockets open: give them time to drain after SIGTERM (compose: stop_grace_period).
CMD ["node", "dist/main.js"]
