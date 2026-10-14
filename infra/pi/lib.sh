# Shared by up.sh, down.sh, logs.sh and reset.sh (B112). Sourced, never run. The Pi has Docker and bash, not
# Node or the Subtype compiler, so everything here is plain bash and docker compose.

PI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$PI_DIR/../.." && pwd)"
STATE_DIR="${PI_STATE_DIR:-$PI_DIR/.state}"
ENV_FILE="$STATE_DIR/pi.env"
COMPOSE_FILE="$PI_DIR/docker-compose.pi.yml"
PI_PROJECT="${PI_PROJECT:-centcom-pi}"
export PI_PROJECT

log() { printf '%s pi: %s\n' "$(date +%H:%M:%S)" "$*"; }
die() {
  local code="$1"
  shift
  printf 'pi: %s\n' "$*" >&2
  exit "$code"
}

# compose ARGS...: docker compose for THIS stack only (its own project name and settings file), so nothing else
# on the machine is ever started, stopped or removed.
compose() {
  local profiles=()
  local p
  for p in ${PI_PROFILES:-}; do profiles+=(--profile "$p"); done
  docker compose --project-name "$PI_PROJECT" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "${profiles[@]}" "$@"
}

# env_value KEY: one value from the settings file (no code runs).
env_value() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

# Random values from the kernel: hex N bytes, base64 32 bytes, base64url 32 bytes.
rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
rand_b64() { head -c 32 /dev/urandom | base64 -w0; }
rand_b64url() { head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '='; }

# The machine's architecture as Docker names it.
docker_arch() {
  case "$(uname -m)" in
    aarch64 | arm64) echo arm64 ;;
    x86_64 | amd64) echo amd64 ;;
    armv7l | armv6l) echo arm ;;
    *) uname -m ;;
  esac
}

# Reads the profiles the settings file chose.
load_profiles() { PI_PROFILES="$(env_value PI_PROFILES)"; export PI_PROFILES; }
