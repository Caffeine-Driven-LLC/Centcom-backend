#!/usr/bin/env bash
# HEALTHCHECK of the one-container test server (B112): the API and the relay answer /readyz, Postgres accepts
# connections, Redis answers PING (and the object store and the mail catcher are up). Exit 0 healthy, 1 not.
set -uo pipefail
SECRETS="${AIO_DATA_DIR:-/data}/secrets/aio.env"
fail() { echo "unhealthy: $1" >&2; exit 1; }
curl -fsS --max-time 4 http://127.0.0.1:3000/readyz >/dev/null || fail "api"
curl -fsS --max-time 4 http://127.0.0.1:8088/readyz >/dev/null || fail "relay"
pg_isready="$(ls /usr/lib/postgresql/*/bin/pg_isready | head -n 1)"
"$pg_isready" -q -h /var/run/postgresql -U centcom -d centcom || fail "postgres"
pw="$(grep -E '^REDIS_PASSWORD=' "$SECRETS" 2>/dev/null | head -n 1 | cut -d= -f2-)"
REDISCLI_AUTH="$pw" redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG || fail "redis"
curl -fsS --max-time 4 "http://127.0.0.1:${AIO_S3_PORT:-9000}/minio/health/live" >/dev/null || fail "minio"
curl -fsS --max-time 4 http://127.0.0.1:8025/readyz >/dev/null || fail "mailpit"
curl -fsS --max-time 4 http://127.0.0.1:8080/healthz >/dev/null || fail "front door"
echo ok
