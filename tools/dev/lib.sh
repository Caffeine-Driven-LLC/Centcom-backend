# Shared by tools/dev/up.sh, down.sh and reset.sh (B012): the compose command, the stack's ports
# and connection strings, and the checks and files around them. Sourced, never run.

DEV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV_COMPOSE_FILE="$DEV_ROOT/infra/compose/docker-compose.yml"
DEV_ENV_EXAMPLE="$DEV_ROOT/.env.example"
DEV_ENV_LOCAL="$DEV_ROOT/.env.local"
# How long `pnpm dev:up` may take, start to finish (images cached).
DEV_UP_TIMEOUT_S="${CENTCOM_DEV_UP_TIMEOUT_S:-90}"

# Host ports, each movable with the variable named on its line (as in docker-compose.yml).
DEV_POSTGRES_PORT="${CENTCOM_DEV_POSTGRES_PORT:-5432}"
DEV_REDIS_PORT="${CENTCOM_DEV_REDIS_PORT:-6379}"
DEV_MINIO_PORT="${CENTCOM_DEV_MINIO_PORT:-9000}"
DEV_MINIO_CONSOLE_PORT="${CENTCOM_DEV_MINIO_CONSOLE_PORT:-9001}"
DEV_SMTP_PORT="${CENTCOM_DEV_SMTP_PORT:-1025}"
DEV_MAILPIT_PORT="${CENTCOM_DEV_MAILPIT_PORT:-8025}"

# "service port variable" for each published port.
dev_ports() {
  cat <<EOF
postgres $DEV_POSTGRES_PORT CENTCOM_DEV_POSTGRES_PORT
redis $DEV_REDIS_PORT CENTCOM_DEV_REDIS_PORT
minio $DEV_MINIO_PORT CENTCOM_DEV_MINIO_PORT
minio $DEV_MINIO_CONSOLE_PORT CENTCOM_DEV_MINIO_CONSOLE_PORT
mailpit $DEV_SMTP_PORT CENTCOM_DEV_SMTP_PORT
mailpit $DEV_MAILPIT_PORT CENTCOM_DEV_MAILPIT_PORT
EOF
}

DEV_DATABASE_URL="postgres://centcom:dev-only@127.0.0.1:$DEV_POSTGRES_PORT/centcom_dev"
DEV_REDIS_URL="redis://127.0.0.1:$DEV_REDIS_PORT/0"

# Runs `docker compose` (or `podman compose`) on the dev stack's file.
dev_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose --file "$DEV_COMPOSE_FILE" "$@"
  elif podman compose version >/dev/null 2>&1; then
    podman compose --file "$DEV_COMPOSE_FILE" "$@"
  else
    echo "dev: neither 'docker compose' nor 'podman compose' is available; install Docker or Podman" >&2
    return 1
  fi
}

# True when something accepts connections on 127.0.0.1:$1.
dev_port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Fails, naming the port and the variable that moves it, when a port of a service that is not
# running yet is taken. $@: the services already running (their ports are theirs).
dev_check_ports() {
  local service port var running taken=0
  while read -r service port var; do
    for running in "$@"; do
      [[ "$running" == "$service" ]] && continue 2
    done
    if dev_port_in_use "$port"; then
      echo "dev: port $port ($service) is already in use on 127.0.0.1; free it, or set $var to another port" >&2
      taken=1
    fi
  done < <(dev_ports)
  return "$taken"
}

# Writes .env.local from .env.example's names, pointed at the stack, unless it exists already.
# $1 example file, $2 target file. Prints what it did.
dev_write_env_local() {
  local example="$1" target="$2" line
  if [[ -e "$target" ]]; then
    echo "kept $target (delete it to regenerate)"
    return 0
  fi
  {
    echo "# Written by pnpm dev:up (tools/dev/up.sh, B012) for the local dev stack. Git-ignored;"
    echo "# delete it to regenerate. Names come from .env.example; values are dev-only."
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        DATABASE_URL=*) echo "DATABASE_URL=$DEV_DATABASE_URL" ;;
        REDIS_URL=*) echo "REDIS_URL=$DEV_REDIS_URL" ;;
        *) echo "$line" ;;
      esac
    done <"$example"
  } >"$target"
  echo "wrote $target"
}
