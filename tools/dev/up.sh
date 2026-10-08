#!/usr/bin/env bash
# pnpm dev:up (B012): starts the local stack (infra/compose/docker-compose.yml), waits until every
# service is healthy, creates the buckets, writes .env.local if it is missing, migrates with
# centcom-db and seeds (tools/dev/seed.ts), then prints the URLs. Running it again is safe.
#
# Exit codes: 0 up; 1 a port is taken, a service did not get healthy in time (its last 50 log lines
# are printed), or a step failed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$DEV_ROOT"

started=$SECONDS
remaining() {
  local left=$((DEV_UP_TIMEOUT_S - (SECONDS - started)))
  echo $((left > 1 ? left : 1))
}

mapfile -t running < <(dev_compose ps --services --status running 2>/dev/null || true)
dev_check_ports "${running[@]}"

echo "Starting the dev stack (Postgres, Redis, MinIO, Mailpit)..."
if ! dev_compose up --detach --wait --wait-timeout "$(remaining)"; then
  echo "dev: the stack did not get healthy within ${DEV_UP_TIMEOUT_S} s" >&2
  while read -r service health; do
    [[ "$health" == "healthy" ]] && continue
    echo "--- $service (${health:-not running}): last 50 log lines" >&2
    dev_compose logs --no-color --tail 50 "$service" >&2 || true
  done < <(dev_compose ps --all --format '{{.Service}} {{.Health}}')
  exit 1
fi

dev_compose exec -T minio bash /opt/centcom/minio-init.sh
dev_write_env_local "$DEV_ENV_EXAMPLE" "$DEV_ENV_LOCAL"

export NODE_ENV=development DATABASE_URL="$DEV_DATABASE_URL"
# The centcom-db CLI (B007), run from source like the seed: no build needed first.
pnpm --silent exec tsx --tsconfig tsconfig.test.json packages/db/src/cli.ts migrate
pnpm --silent dev:seed

cat <<EOF

Centcom dev stack is up ($((SECONDS - started)) s).
  Postgres     $DEV_DATABASE_URL
  Redis        $DEV_REDIS_URL
  MinIO (S3)   http://127.0.0.1:$DEV_MINIO_PORT   access key centcom, secret dev-only
  MinIO UI     http://127.0.0.1:$DEV_MINIO_CONSOLE_PORT
  Mailpit      SMTP 127.0.0.1:$DEV_SMTP_PORT, UI http://127.0.0.1:$DEV_MAILPIT_PORT
Stop it with pnpm dev:down; wipe it with pnpm dev:reset. See docs/dev-environment.md.
EOF
