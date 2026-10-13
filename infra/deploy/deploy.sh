#!/usr/bin/env bash
# Deploys a tag to this server (B092): build, back up and migrate, start, check, roll back on failure.
#
#   infra/deploy/deploy.sh <tag> [--allow-contract] [--skip-build]
#
# Steps:
#   1. check the settings file (no placeholders, mode 600, compose validates);
#   2. build the api, worker and relay images as centcom-*:<tag> (the previous tag's images stay);
#   3. migrate-safe.sh: pre-deploy backup, then the pending migrations;
#   4. start order: object store and its buckets, api (wait healthy), worker, relay (wait healthy,
#      drains the old relay for up to 60 s), caddy;
#   5. any service that does not become healthy within DEPLOY_WAIT_S (default 120) stops the
#      deploy: the previous tag is started again (rollback.sh --images) and the exit code is 20.
# Only one deploy runs at a time (a lock in the state folder); a second one stops with a message.
#
# Exit codes: 0 deployed; 1 a step failed; 2 usage or incomplete settings; 3 contract migration
# pending; 20 the new version was unhealthy and the old one was restored; 21 the restore failed too.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag="" allow_contract=() skip_build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-contract) allow_contract=(--allow-contract); shift ;;
    --skip-build) skip_build=1; shift ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) die "$EXIT_USAGE" "unknown option $1" ;;
    *) tag="$1"; shift ;;
  esac
done
[[ -n "$tag" ]] || die "$EXIT_USAGE" "usage: deploy.sh <tag> [--allow-contract] [--skip-build]"
[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "$EXIT_USAGE" "the tag must be letters, digits, . _ - (got: $tag)"
export TAG="$tag"
WAIT_S="${DEPLOY_WAIT_S:-120}"

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die 1 "another deploy is running (lock $STATE_DIR/deploy.lock); wait for it to finish"

preflight_env
previous="$(state_get current-tag)"
log "deploying $tag (running now: ${previous:-nothing})"

if [[ $skip_build -eq 0 ]]; then
  log "building images"
  compose build api worker relay
fi

"$DEPLOY_DIR/migrate-safe.sh" --tag "$tag" "${allow_contract[@]}"

unhealthy() {
  log "FAILED: $1"
  compose logs --no-color --tail 25 api worker relay 2>&1 | sed 's/^/    /' >&2 || true
  state_event "deploy $tag failed: $1"
  if [[ -z "$previous" ]]; then
    die "$EXIT_UNHEALTHY" "no previous version to go back to; read the logs: docker compose logs"
  fi
  log "restoring $previous"
  if "$DEPLOY_DIR/rollback.sh" --images --to "$previous"; then
    die "$EXIT_UNHEALTHY" "$tag was not healthy; $previous is serving again"
  fi
  die "$EXIT_ROLLBACK_FAILED" "$tag was not healthy and restoring $previous failed too: act now"
}

up() { # up <service>... : start and wait for the health check
  compose up --detach --no-deps --wait --wait-timeout "$WAIT_S" "$@" >/dev/null 2>&1 || return 1
}

log "starting the data services and the object store buckets"
compose up --detach --wait --wait-timeout "$WAIT_S" postgres redis minio >/dev/null
compose up minio-init >/dev/null

up api || unhealthy "api did not become healthy (waited up to ${WAIT_S}s)"
up worker || unhealthy "worker did not start"
# The relay last among the services: recreating it drains the old one (SIGTERM, up to 60 s); its
# clients reconnect and resume from their last seq.
up relay || unhealthy "relay did not become healthy (waited up to ${WAIT_S}s)"
up caddy || unhealthy "caddy did not start"

state_set previous-tag "$previous"
state_set current-tag "$tag"
state_event "deployed $tag (previous: ${previous:-none})"
log "deployed $tag"
compose ps --format 'table {{.Service}}\t{{.Status}}'
