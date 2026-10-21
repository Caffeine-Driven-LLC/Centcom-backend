#!/usr/bin/env bash
# The one-container Centcom test server (B112). Runs as PID 2 under tini. FOR TESTING ONLY.
#
#   1. makes every secret on the first start (under $AIO_DATA_DIR/secrets, mode 600), never from the image;
#   2. initialises Postgres once, applies the migrations, creates the MinIO buckets;
#   3. starts Postgres, Redis, MinIO, Mailpit, the API, the worker, the relay and Caddy, in that order, each under a
#      small supervisor that restarts it when it dies (a crash loop backs off up to 30 s);
#   4. prints a ready banner, then waits; SIGTERM/SIGINT stop everything in the reverse order and exit 0.
#
# Settings (environment): TEST_SERVER_HOST (default localhost), AIO_TLS (1: HTTPS with a private CA, for other
# computers), AIO_PUBLIC_API_URL / AIO_RELAY_PUBLIC_URL (override the advertised addresses), AIO_DATA_DIR (/data),
# SELF_HOST_PLAN (default team), LOG_LEVEL (info). Exit codes: 0 stopped; 1 start failed; 2 bad settings.
set -euo pipefail

DATA="${AIO_DATA_DIR:-/data}"
HOST="${TEST_SERVER_HOST:-localhost}"
RUN=/run/centcom
SECRETS="$DATA/secrets/aio.env"
TLS="${AIO_TLS:-0}"
TLS_PORT="${AIO_TLS_PORT:-8443}"
CA_PORT="${AIO_HTTP_CA_PORT:-8081}"
PLAN="${SELF_HOST_PLAN:-team}"
S3_PORT="${AIO_S3_PORT:-9000}"
S3_TLS_PORT="${AIO_S3_TLS_PORT:-9443}"
export AIO_TLS_PORT="$TLS_PORT" AIO_HTTP_CA_PORT="$CA_PORT" AIO_S3_TLS_PORT="$S3_TLS_PORT" TEST_SERVER_HOST="$HOST"

log() { printf '%s aio: %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { local c="$1"; shift; printf 'aio: %s\n' "$*" >&2; exit "$c"; }

[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$ ]] || die 2 "TEST_SERVER_HOST must be a host name or an address (got: $HOST)"
[[ "$TLS" =~ ^[01]$ ]] || die 2 "AIO_TLS is 0 or 1"
[[ "$PLAN" =~ ^(free|pro|team|business)$ ]] || log "note: SELF_HOST_PLAN=$PLAN is not a plan name this script knows; the API decides"

rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
rand_b64() { head -c 32 /dev/urandom | base64 -w0; }
rand_b64url() { head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '='; }

START_EPOCH=$(date +%s)
mkdir -p "$RUN" "$DATA"/{secrets,postgres,redis,minio,mailpit,caddy}
rm -f "$RUN"/*.pid "$RUN/stopping"
chown centcom:centcom "$RUN" "$DATA" "$DATA"/{redis,minio,mailpit,caddy}
chown postgres:postgres "$DATA/postgres"
chmod 700 "$DATA/postgres" "$DATA/secrets"

# ---- 1. secrets (once) -------------------------------------------------------------------------------------
if [[ ! -s "$SECRETS" ]]; then
  log "first start: making new secrets in $SECRETS (mode 600, never in the image)"
  kid="k$(date +%Y%m%d)"
  jwks="$(node -e "
    const { generateKeyPairSync } = require('node:crypto');
    const j = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    process.stdout.write(JSON.stringify([{ kty: 'OKP', crv: 'Ed25519', kid: '$kid', x: j.x, d: j.d }]));")"
  [[ -n "$jwks" ]] || die 1 "could not make the token signing key"
  (
    umask 077
    {
      echo "# Generated on first start. Secrets for THIS test server only; reset.sh deletes them."
      echo "POSTGRES_PASSWORD=$(rand_hex 24)"
      echo "REDIS_PASSWORD=$(rand_hex 24)"
      echo "IDEMPOTENCY_ENCRYPTION_KEY=$(rand_b64)"
      echo "CURSOR_SIGNING_KEYS=c1:$(rand_b64url)"
      echo "OBJECT_STORE_ACCESS_KEY_ID=centcom$(rand_hex 6)"
      echo "OBJECT_STORE_SECRET_ACCESS_KEY=$(rand_hex 24)"
      echo "AUTH_SIGNING_KID=$kid"
      echo "AUTH_SIGNING_KEYS='$jwks'"
    } >"$SECRETS"
  )
fi
chmod 600 "$SECRETS"
set -a
# shellcheck disable=SC1090
source "$SECRETS"
set +a

# ---- 2. the addresses the apps will be given ----------------------------------------------------------------
if [[ "$TLS" == 1 ]]; then
  api_url="https://$HOST:$TLS_PORT"; relay_url="wss://$HOST:$TLS_PORT/v1/ws"; s3_url="https://$HOST:$S3_TLS_PORT"
else
  api_url="http://$HOST:3000"; relay_url="ws://$HOST:8088/v1/ws"; s3_url="http://$HOST:$S3_PORT"
fi
# The API hands clients presigned object-store URLs (session snapshots), so the store's address must be one the
# clients can reach too: the same host name as the API, on the store's own port (through Caddy's HTTPS in TLS mode).
# Inside the container the host name is made to point at this machine so that the services reach it directly.
# A name goes into /etc/hosts. An IPv4 address (not 127.x) becomes an address of the loopback interface, which needs
# NET_ADMIN (run.sh --tls adds it); without it the services would reach the address through the host's network and
# a firewall may drop that.
if [[ "$HOST" =~ ^127\. ]]; then :
elif [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  ip addr add "$HOST/32" dev lo 2>/dev/null || log "note: could not add $HOST to the loopback interface (start the container with --cap-add NET_ADMIN); the services reach it through the host's network"
elif [[ ! "$HOST" =~ : ]] && ! grep -qE "[[:space:]]$HOST\$" /etc/hosts; then echo "127.0.0.1 $HOST" >>/etc/hosts; fi
api_url="${AIO_PUBLIC_API_URL:-$api_url}"
relay_url="${AIO_RELAY_PUBLIC_URL:-$relay_url}"
api_url="${api_url%/}"

# The environment the API and the worker share (the relay gets its own subset below).
common_env=(
  NODE_ENV=production LOG_LEVEL="${LOG_LEVEL:-info}" PUBLIC_API_URL="$api_url"
  DATABASE_URL="postgres://centcom:${POSTGRES_PASSWORD}@127.0.0.1:5432/centcom"
  REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:6379/0"
  ALLOW_INSECURE_BACKENDS=1 RELAY_REGION=aio
  OBJECT_STORE_ENDPOINT="$s3_url" OBJECT_STORE_REGION=us-east-1 OBJECT_STORE_BUCKET=history
  OBJECT_STORE_ACCESS_KEY_ID="$OBJECT_STORE_ACCESS_KEY_ID" OBJECT_STORE_SECRET_ACCESS_KEY="$OBJECT_STORE_SECRET_ACCESS_KEY"
)
api_env=(
  "${common_env[@]}" TRUSTED_PROXY_HOPS=1
  AUTH_SIGNING_KEYS="$AUTH_SIGNING_KEYS" AUTH_SIGNING_KID="$AUTH_SIGNING_KID"
  IDEMPOTENCY_ENCRYPTION_KEY="$IDEMPOTENCY_ENCRYPTION_KEY" CURSOR_SIGNING_KEYS="$CURSOR_SIGNING_KEYS"
  # Mail goes over SMTP to the Mailpit in this container (the production path: API -> queue -> worker -> SMTP).
  EMAIL_PROVIDER=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURE=none
  EMAIL_FROM="Centcom <no-reply@centcom.test>"
  WEB_BASE_URL=https://centcom.dev MAGIC_LINK_BASE_URL="$api_url"
  LOGIN_RETURN_TO_ALLOWLIST="$api_url/device" DEVICE_VERIFICATION_URI="$api_url/device"
  RELAY_PUBLIC_URL="$relay_url"
  # No billing here: every new personal workspace gets this plan, so a Free account can host sessions.
  SELF_HOST_PLAN="$PLAN"
  # Relaxed only because scripted checks sign several accounts in within a minute (production defaults are lower).
  RATELIMIT_AUTH_LIMIT=200 RATELIMIT_ANONYMOUS_LIMIT=300
  HOST=0.0.0.0 PORT=3000
)
# In HTTPS mode the store is reached through Caddy with its private CA, which the API and the worker must trust.
[[ "$TLS" != 1 ]] || api_env+=(NODE_EXTRA_CA_CERTS="$DATA/caddy/pki/authorities/local/root.crt")
# For test-token.sh (scripted checks): the API's environment as a file that only root can read, gone with the container.
( umask 077; for kv in "${api_env[@]}"; do printf 'export %q\n' "$kv"; done >"$RUN/api.env.sh" )
relay_env=(
  "${common_env[@]}" OBJECT_STORE_ENDPOINT="http://127.0.0.1:$S3_PORT" HOST=0.0.0.0 RELAY_PORT=8088 RELAY_JWKS_URL=http://127.0.0.1:3000/.well-known/jwks.json
  RELAY_MAX_CONNECTIONS=300
)

# ---- supervisor ---------------------------------------------------------------------------------------------
ORDER=()   # started services, in start order
SUPS=()    # the supervisor loops (background subshells)
STOPPING=0

# supervise NAME STOP_SIGNAL CMD...: runs CMD in a loop in the background; the child's pid is $RUN/NAME.pid.
supervise() {
  local name="$1" sig="$2"; shift 2
  (
    local delay=1 began code child
    while [[ ! -e "$RUN/stopping" ]]; do
      began=$(date +%s)
      "$@" &
      child=$!
      echo "$child" >"$RUN/$name.pid"
      echo "$sig" >"$RUN/$name.sig"
      code=0; wait "$child" || code=$?
      rm -f "$RUN/$name.pid"
      [[ ! -e "$RUN/stopping" ]] || break
      # a service that ran for a minute is healthy again: start over with a short delay
      (( $(date +%s) - began > 60 )) && delay=1
      log "$name exited with code $code; restarting in ${delay}s"
      sleep "$delay"
      delay=$(( delay * 2 > 30 ? 30 : delay * 2 ))
    done
  ) &
  SUPS+=("$!")
  ORDER+=("$name")
}

stop_all() {
  [[ $STOPPING -eq 0 ]] || return 0
  STOPPING=1
  log "stopping"
  : >"$RUN/stopping"
  local i name pid sig n
  for ((i = ${#ORDER[@]} - 1; i >= 0; i--)); do
    name="${ORDER[$i]}"
    pid="$(cat "$RUN/$name.pid" 2>/dev/null || true)"
    [[ -n "$pid" ]] || continue
    sig="$(cat "$RUN/$name.sig" 2>/dev/null || echo TERM)"
    kill -"$sig" "$pid" 2>/dev/null || continue
    for ((n = 0; n < 300; n++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then log "$name did not stop in 30 s; killing it"; kill -KILL "$pid" 2>/dev/null || true; fi
  done
  # a supervisor loop may be asleep between restarts: it has nothing left to do
  for pid in "${SUPS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  log "stopped"
}
on_signal() { stop_all; exit 0; }
trap on_signal TERM INT
# A start-up failure stops what already runs and exits non-zero.
fail() { log "$*"; stop_all; exit 1; }

wait_for() { # wait_for WHAT SECONDS CMD...
  local what="$1" secs="$2" i; shift 2
  for ((i = 0; i < secs * 2; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  fail "$what did not become ready in ${secs}s"
}

as_app() { gosu centcom env "${@}"; }   # as_app VAR=value... command...

# ---- 3. Postgres -------------------------------------------------------------------------------------------
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -n 1)"
if [[ ! -s "$DATA/postgres/PG_VERSION" ]]; then
  log "first start: initialising Postgres"
  pwfile="$(mktemp)"; printf '%s' "$POSTGRES_PASSWORD" >"$pwfile"; chown postgres "$pwfile"
  gosu postgres "$PGBIN/initdb" --pgdata="$DATA/postgres" --username=centcom --pwfile="$pwfile" \
    --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  rm -f "$pwfile"
fi
mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql
supervise postgres INT gosu postgres "$PGBIN/postgres" -D "$DATA/postgres" \
  -c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=/var/run/postgresql \
  -c shared_buffers=128MB -c effective_cache_size=512MB -c max_connections=50 -c work_mem=4MB \
  -c maintenance_work_mem=32MB -c synchronous_commit=off -c checkpoint_timeout=15min -c max_wal_size=512MB
wait_for "postgres" 60 "$PGBIN/pg_isready" -h /var/run/postgresql -U centcom -d centcom -q
if ! gosu postgres psql -h /var/run/postgresql -U centcom -d postgres -Atc "select 1 from pg_database where datname='centcom'" | grep -q 1; then
  gosu postgres createdb -h /var/run/postgresql -U centcom centcom
fi

# ---- Redis, MinIO, Mailpit ---------------------------------------------------------------------------------
# BullMQ needs noeviction; the snapshot (RDB) is small and lets a restart keep the queued jobs.
supervise redis TERM gosu centcom env REDIS_PW="$REDIS_PASSWORD" bash -c \
  'exec redis-server --bind 127.0.0.1 --port 6379 --dir "$0" --save 300 1 --appendonly no --maxmemory 128mb --maxmemory-policy noeviction --requirepass "$REDIS_PW"' "$DATA/redis"
supervise minio TERM gosu centcom env MINIO_ROOT_USER="$OBJECT_STORE_ACCESS_KEY_ID" MINIO_ROOT_PASSWORD="$OBJECT_STORE_SECRET_ACCESS_KEY" \
  GOMEMLIMIT=256MiB MINIO_BROWSER_REDIRECT_URL="http://$HOST:9001" \
  minio server "$DATA/minio" --address 0.0.0.0:$S3_PORT --console-address 0.0.0.0:9001 --quiet
supervise mailpit TERM gosu centcom env MP_SMTP_AUTH_ACCEPT_ANY=1 MP_SMTP_AUTH_ALLOW_INSECURE=1 MP_MAX_MESSAGES=500 \
  mailpit --smtp 127.0.0.1:1025 --listen 0.0.0.0:8025 --database "$DATA/mailpit/mailpit.db"
wait_for "redis" 30 bash -c 'REDISCLI_AUTH="$0" redis-cli -h 127.0.0.1 ping | grep -q PONG' "$REDIS_PASSWORD"
wait_for "minio" 60 curl -fsS "http://127.0.0.1:$S3_PORT/minio/health/live"
wait_for "mailpit" 30 curl -fsS http://127.0.0.1:8025/readyz
log "creating the object-store buckets"
S3_ENDPOINT="http://127.0.0.1:$S3_PORT" MINIO_ROOT_USER="$OBJECT_STORE_ACCESS_KEY_ID" MINIO_ROOT_PASSWORD="$OBJECT_STORE_SECRET_ACCESS_KEY" \
  bash /etc/centcom/minio-init.sh >/dev/null || fail "creating the buckets failed"

# ---- 4. migrations (the normal runner: advisory-locked, each file in its own transaction) -------------------
log "applying the migrations"
(cd /app/api && gosu centcom env "${common_env[@]}" node node_modules/@centcom/db/dist/cli.js migrate) >"$RUN/migrate.log" 2>&1 \
  || { tail -n 20 "$RUN/migrate.log" >&2; fail "the migrations failed"; }
tail -n 2 "$RUN/migrate.log"

# ---- 5. the front door (before the API in HTTPS mode: its CA is trusted by the API) ------------------------------
if [[ "$TLS" == 1 ]]; then cp /etc/centcom/Caddyfile.tls "$RUN/tls.caddy"; else : >"$RUN/tls.caddy"; fi
chown centcom "$RUN/tls.caddy"
supervise caddy TERM gosu centcom env XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$DATA/caddy-config" \
  caddy run --config /etc/centcom/Caddyfile --adapter caddyfile
if [[ "$TLS" == 1 ]]; then wait_for "the CA certificate" 60 test -s "$DATA/caddy/pki/authorities/local/root.crt"; fi

# ---- 6. the Centcom services ------------------------------------------------------------------------------
cd /app/api
supervise api TERM gosu centcom env "${api_env[@]}" SERVICE_NAME=api NODE_OPTIONS=--max-old-space-size=256 node dist/main.js
supervise worker TERM gosu centcom env "${api_env[@]}" SERVICE_NAME=worker NODE_OPTIONS=--max-old-space-size=192 node dist/main.js --worker
wait_for "the API" 90 curl -fsS http://127.0.0.1:3000/readyz
cd /app/relay
supervise relay TERM gosu centcom env "${relay_env[@]}" SERVICE_NAME=relay NODE_OPTIONS=--max-old-space-size=256 node dist/main.js
wait_for "the relay" 60 curl -fsS http://127.0.0.1:8088/readyz
wait_for "the front door" 30 curl -fsS http://127.0.0.1:8080/healthz


secs=$(( $(date +%s) - START_EPOCH ))
cat <<TXT

==========================================================================================
 Centcom test server is READY (${secs}s).   FOR TESTING ONLY: development settings, no backups.
==========================================================================================
 API            $api_url          (also http://$HOST:8080 behind the front door)
 Relay          $relay_url
 Mail (codes)   http://$HOST:8025      <- sign-in codes and links arrive here
 Object store   $s3_url   (presigned snapshot URLs point here)
 MinIO console  http://$HOST:9001      (only if you published port 9001; login in $SECRETS)
 Plan           every new account is on '$PLAN' (SELF_HOST_PLAN), so it can host sessions
 Data           $DATA   (secrets, database, files, mail)
TXT
[[ "$TLS" != 1 ]] || echo " CA             http://$HOST:$CA_PORT/ca.crt   (every computer that connects must trust it)"
echo

# ---- 7. wait: restart-on-crash lives in the supervisor loops; this only waits for a signal -------------------------
while :; do
  wait -n "${SUPS[@]}" 2>/dev/null || true
  [[ $STOPPING -eq 0 ]] || break
  # a supervisor loop only ends when asked to; if one is gone, something is badly wrong
  alive=0; for p in "${SUPS[@]}"; do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done
  (( alive == ${#SUPS[@]} )) || fail "a supervisor loop ended"
  sleep 1
done
