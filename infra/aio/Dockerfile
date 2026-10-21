# syntax=docker/dockerfile:1
# One container that hosts the whole Centcom test server (B112): API, relay, worker, Postgres 16, Redis 7, MinIO
# (the relay's S3 store), Mailpit (sign-in codes), Caddy (the front door). FOR TESTING ONLY. See
# docs/ops/test-server-container.md.
#
#   docker build -f infra/aio/Dockerfile -t centcom-test:aio .          (run.sh does this for you)
#
# Works on amd64 and arm64 (a Raspberry Pi 4 with a 64-bit OS): every download below has a sha256 for both.
# No secret is in the image: the entrypoint makes them on first start, inside the data volume.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
ARG POSTGRES_IMAGE=postgres:16-bookworm@sha256:07f75b9a180f8c1feb17354ea9dcc556876d805802412f71b2173ff0c8f0b176
ARG REDIS_IMAGE=redis:7-bookworm@sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b
# MinIO's own download server (dl.min.io) no longer serves release binaries (HTTP 410), so the binary is copied
# from the image the Pi stack already uses, pinned by its multi-arch digest.
ARG MINIO_IMAGE=bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20

# ---- build: the same stage as infra/deploy/Dockerfile (a test keeps them identical), so the layers are shared ----
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

FROM ${NODE_IMAGE} AS node-bin
FROM ${REDIS_IMAGE} AS redis-bin
FROM ${MINIO_IMAGE} AS minio-bin

# ---- runtime: the official Postgres 16 (Debian 12) image is the base; Node, Redis and MinIO are copied in ----
FROM ${POSTGRES_IMAGE} AS runtime
ARG TARGETARCH
# Pinned downloads, one sha256 per architecture.
ARG MAILPIT_VERSION=1.31.4
ARG MAILPIT_SHA256_AMD64=30942c4605c2ca8b9f759b1bb4e3ab6a12bdfdf66e5c94644ec2c75ac41e88e7
ARG MAILPIT_SHA256_ARM64=010a346a8b9d454f6fa22d4fd2dbd5bf5eb7104688412b9c130d0ba33a3579c4
ARG CADDY_VERSION=2.10.2
ARG CADDY_SHA256_AMD64=5c218bc34c9197369263da7e9317a83acdbd80ef45d94dca5eff76e727c67cdd
ARG CADDY_SHA256_ARM64=501e955fa634c5aab63247458c3ac655cfdd6cbf1e0436528f41248451c190ac
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
# tini is PID 1 so SIGTERM reaches the entrypoint and zombies are reaped; libstdc++ is Node's one library; iproute2
# lets HTTPS mode on an IP address point that address at the container itself (see entrypoint.sh). The apt packages stay unpinned (Debian replaces them
# in place), and one RUN downloads and installs both binaries, so it changes directory.
# hadolint ignore=DL3003,DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates libstdc++6 iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) mp_sha="$MAILPIT_SHA256_AMD64"; cd_sha="$CADDY_SHA256_AMD64" ;; \
      arm64) mp_sha="$MAILPIT_SHA256_ARM64"; cd_sha="$CADDY_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && mkdir /tmp/dl && cd /tmp/dl \
 && curl -fsSL -o mailpit.tar.gz "https://github.com/axllent/mailpit/releases/download/v${MAILPIT_VERSION}/mailpit-linux-${arch}.tar.gz" \
 && echo "${mp_sha}  mailpit.tar.gz" | sha256sum -c - \
 && tar -xzf mailpit.tar.gz mailpit && install -m 0755 mailpit /usr/local/bin/mailpit \
 && curl -fsSL -o caddy.tar.gz "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${arch}.tar.gz" \
 && echo "${cd_sha}  caddy.tar.gz" | sha256sum -c - \
 && tar -xzf caddy.tar.gz caddy && install -m 0755 caddy /usr/local/bin/caddy \
 && cd / && rm -rf /tmp/dl \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin centcom
COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node
COPY --from=redis-bin /usr/local/bin/redis-server /usr/local/bin/redis-cli /usr/local/bin/
COPY --from=minio-bin /opt/bitnami/minio/bin/minio /usr/local/bin/minio
COPY --from=build --chown=centcom:centcom /out/api/ /app/api/
COPY --from=build --chown=centcom:centcom /out/relay/ /app/relay/
COPY infra/aio/entrypoint.sh infra/aio/healthcheck.sh /usr/local/bin/
COPY infra/aio/Caddyfile /etc/centcom/Caddyfile
COPY infra/aio/Caddyfile.tls /etc/centcom/Caddyfile.tls
COPY infra/compose/minio-init.sh /etc/centcom/minio-init.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

ENV NODE_ENV=production \
    SERVICE_VERSION=aio \
    AIO_DATA_DIR=/data \
    TEST_SERVER_HOST=localhost
VOLUME /data
# 3000 API, 8088 relay, 8080 front door (both behind one port), 8025 mail, 9001 MinIO console (optional),
# 8443 and 8081 only in AIO_TLS=1 mode (HTTPS with a private CA, and the CA download).
EXPOSE 3000 8088 8080 8025 9000 9001 8443 8081 9443
HEALTHCHECK --interval=15s --timeout=8s --start-period=90s --retries=4 CMD ["/usr/local/bin/healthcheck.sh"]
# Docker's default 10 s is too short for the relay to drain its sockets and Postgres to stop cleanly.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
