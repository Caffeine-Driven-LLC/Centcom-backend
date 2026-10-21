# Shared by run.sh, stop.sh and reset.sh (B112). Sourced, never run. Plain bash and docker only.
AIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$AIO_DIR/../.." && pwd)"
AIO_NAME="${AIO_NAME:-centcom-test}"
AIO_IMAGE="${AIO_IMAGE:-centcom-test:aio}"
AIO_VOLUME="${AIO_VOLUME:-centcom-data}"
AIO_STATE_DIR="${AIO_STATE_DIR:-$HOME/.centcom-test}"

log() { printf '%s aio: %s\n' "$(date +%H:%M:%S)" "$*"; }
die() {
  local code="$1"
  shift
  printf 'aio: %s\n' "$*" >&2
  exit "$code"
}
need_docker() {
  command -v docker >/dev/null || die 2 "Docker is not installed (https://docs.docker.com/engine/install/)"
  docker info >/dev/null 2>&1 || die 2 "Docker is installed but this user cannot talk to it (add yourself to the docker group, log in again)"
}
# Only the container this script family made is ever touched: it must carry the label.
is_ours() { [[ "$(docker inspect --format '{{index .Config.Labels "dev.centcom.aio"}}' "$1" 2>/dev/null)" == "1" ]]; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
