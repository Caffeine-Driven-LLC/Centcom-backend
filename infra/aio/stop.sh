#!/usr/bin/env bash
# Stops and removes the one-container test server (B112) and nothing else: only the container named centcom-test (or
# --name) that carries this project's label. The data volume stays; run.sh starts it again with the same accounts.
# A throwaway server (run.sh --fresh) is gone completely.
#
#   infra/aio/stop.sh [--name NAME]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) AIO_NAME="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die 2 "unknown option $1" ;;
  esac
done
need_docker
exists "$AIO_NAME" || { log "no container named $AIO_NAME: nothing to stop"; exit 0; }
is_ours "$AIO_NAME" || die 2 "$AIO_NAME is not a Centcom test server (no dev.centcom.aio label): not touching it"
docker stop --time 60 "$AIO_NAME" >/dev/null
# -v removes the anonymous volume the Postgres base image declares; the named data volume is kept.
docker rm -v "$AIO_NAME" >/dev/null
log "stopped $AIO_NAME (the data volume is kept)"
