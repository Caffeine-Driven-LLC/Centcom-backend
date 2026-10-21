#!/usr/bin/env bash
# Back to a clean slate (B112): stops the test server and deletes its data volume (accounts, sessions, mail, the
# secrets and the certificate authority), and nothing else. The next run.sh starts a new server.
#
#   infra/aio/reset.sh [--yes] [--name NAME] [--volume NAME]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yes=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --name) AIO_NAME="${2:?}"; shift 2 ;;
    --volume) AIO_VOLUME="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,6p' "$0"; exit 0 ;;
    *) die 2 "unknown option $1" ;;
  esac
done
need_docker
if [[ $yes -eq 0 ]]; then
  read -r -p "Delete ALL data of the Centcom test server (volume $AIO_VOLUME: accounts, sessions, mail, secrets)? [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]] || die 1 "cancelled"
fi
if exists "$AIO_NAME"; then
  is_ours "$AIO_NAME" || die 2 "$AIO_NAME is not a Centcom test server: not touching it"
  docker stop --time 60 "$AIO_NAME" >/dev/null
  docker rm -v "$AIO_NAME" >/dev/null
fi
if docker volume inspect "$AIO_VOLUME" >/dev/null 2>&1; then
  docker volume rm "$AIO_VOLUME" >/dev/null
  log "deleted the volume $AIO_VOLUME; run.sh starts a clean server"
else
  log "no volume $AIO_VOLUME: nothing to delete"
fi
