# Shared by deploy.sh, migrate-safe.sh and rollback.sh (B091/B092). Sourced, never run.
#
# Why bash and not Subtype here: these scripts run on the server, which has Docker and bash but
# not the `sub` compiler. Local helpers that drive them are in the maintainer's ops folder.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
ENV_FILE="${DEPLOY_ENV_FILE:-$DEPLOY_DIR/production.env}"
STATE_DIR="${DEPLOY_STATE_DIR:-$DEPLOY_DIR/.state}"
# Exit codes shared by the scripts.
EXIT_USAGE=2 EXIT_CONTRACT=3 EXIT_UNHEALTHY=20 EXIT_ROLLBACK_FAILED=21

log() { printf '%s deploy: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  local code="$1"
  shift
  printf 'deploy: %s\n' "$*" >&2
  exit "$code"
}

# docker compose on the production file and the settings file.
compose() { docker compose --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Reads one KEY from the settings file without sourcing it (no code runs, no secret is printed).
env_value() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%"${line##*[![:space:]]}"}"
  line="${line#\'}"
  line="${line%\'}"
  printf '%s' "$line"
}

# Stops with EXIT_USAGE unless the settings file is complete: no GENERATE: or CHANGE_ME left, and
# the keys the stack cannot start without are present.
preflight_env() {
  [[ -f "$ENV_FILE" ]] || die "$EXIT_USAGE" "no settings file at $ENV_FILE; run: node infra/deploy/gen-env.mjs"
  local mode
  mode="$(stat -c '%a' "$ENV_FILE")"
  [[ "$mode" == 600 || "$mode" == 400 ]] || die "$EXIT_USAGE" "$ENV_FILE must be mode 600 (it is $mode): chmod 600 $ENV_FILE"
  local bad
  bad="$(grep -nE '^[A-Z][A-Z0-9_]*=(GENERATE:|CHANGE_ME)' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ' || true)"
  [[ -z "$bad" ]] || die "$EXIT_USAGE" "$ENV_FILE still has unfilled values on line(s): $bad"
  local key
  for key in API_HOST RELAY_HOST PUBLIC_API_URL RELAY_PUBLIC_URL WEB_BASE_URL ACME_EMAIL POSTGRES_PASSWORD \
    REDIS_PASSWORD AUTH_SIGNING_KEYS AUTH_SIGNING_KID IDEMPOTENCY_ENCRYPTION_KEY CURSOR_SIGNING_KEYS \
    OBJECT_STORE_ACCESS_KEY_ID OBJECT_STORE_SECRET_ACCESS_KEY EMAIL_FROM LOGIN_RETURN_TO_ALLOWLIST; do
    [[ -n "$(env_value "$key")" ]] || die "$EXIT_USAGE" "$key is empty in $ENV_FILE"
  done
  compose config --quiet || die "$EXIT_USAGE" "docker-compose.prod.yml does not validate with $ENV_FILE"
}

state_get() { [[ -f "$STATE_DIR/$1" ]] && cat "$STATE_DIR/$1" || true; }
state_set() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$2" >"$STATE_DIR/$1"
}
state_event() {
  mkdir -p "$STATE_DIR"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$STATE_DIR/history.log"
}

# Waits until Postgres accepts connections (it is started if it is not running).
ensure_postgres() {
  compose up --detach --wait --wait-timeout 120 postgres >/dev/null
}

# pg_backup <label>: a custom-format dump of the database into the `backups` volume
# (/backups in the postgres container), checked with pg_restore --list. Prints its file name.
# Keeps the newest BACKUP_KEEP (default 10) pre-deploy dumps.
pg_backup() {
  local label="$1" name
  name="pre-${label}-$(date -u +%Y%m%dT%H%M%SZ).dump"
  ensure_postgres
  compose exec -T postgres pg_dump --username=centcom --dbname=centcom --format=custom \
    --file="/backups/$name" >&2
  compose exec -T postgres sh -c "pg_restore --list '/backups/$name' >/dev/null && test -s '/backups/$name'" >&2 \
    || die 1 "the backup $name was written but cannot be read back"
  compose exec -T postgres sh -c \
    "ls -1t /backups/pre-*.dump 2>/dev/null | tail -n +$(("${BACKUP_KEEP:-10}" + 1)) | xargs -r rm -f" >&2
  printf '%s\n' "$name"
}
