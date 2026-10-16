#!/usr/bin/env bash
# Goes back to an earlier version (B092), in one of two ways:
#
#   rollback.sh --images [--to <tag>]       start the previous (or the given) tag's images again.
#                                           The database stays as it is: this is right whenever the
#                                           newer migrations were additive, which the expand/contract
#                                           rule guarantees. About a minute.
#   rollback.sh --restore-db <dump> [--to <tag>] [--skip-safety-copy]
#                                           also replace the database with a pre-deploy dump (the name
#                                           deploy.sh printed, in /backups). Everything written since the
#                                           dump is LOST; the services are stopped meanwhile. The current
#                                           database is dumped first (pre-before-restore-*.dump in
#                                           /backups) unless --skip-safety-copy.
#
# Exit codes: 0 done; 1 failed; 2 usage.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mode="" dump="" to="" safety=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --images) mode=images; shift ;;
    --restore-db) mode=db; dump="${2:?--restore-db needs a dump name}"; shift 2 ;;
    --to) to="${2:?--to needs a tag}"; shift 2 ;;
    --skip-safety-copy) safety=0; shift ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
[[ -n "$mode" ]] || die "$EXIT_USAGE" "choose --images or --restore-db <dump>"
[[ -n "$to" ]] || to="$(state_get previous-tag)"
[[ -n "$to" ]] || die "$EXIT_USAGE" "no previous tag is recorded; pass --to <tag>"
export TAG="$to"
WAIT_S="${DEPLOY_WAIT_S:-120}"
preflight_env
for image in api worker relay; do
  docker image inspect "centcom-$image:$to" >/dev/null 2>&1 \
    || die 1 "the image centcom-$image:$to is not on this server (build it: deploy.sh $to)"
done

if [[ "$mode" == db ]]; then
  [[ "$dump" =~ ^[A-Za-z0-9._-]+\.dump$ ]] || die "$EXIT_USAGE" "the dump must be a file name from /backups, got: $dump"
  compose exec -T postgres test -s "/backups/$dump" || die 1 "/backups/$dump does not exist or is empty"
  log "stopping api, worker and relay"
  compose stop api worker relay caddy >/dev/null
  if [[ $safety -eq 1 ]]; then safety_copy; fi
  log "restoring the database from $dump"
  compose exec -T postgres dropdb --username=centcom --force --if-exists centcom
  compose exec -T postgres createdb --username=centcom centcom
  compose exec -T postgres pg_restore --username=centcom --dbname=centcom --no-owner --exit-on-error "/backups/$dump"
  state_event "database restored from $dump"
fi

log "starting $to"
compose up --detach --no-deps --wait --wait-timeout "$WAIT_S" api worker relay caddy >/dev/null
state_set current-tag "$to"
state_event "rolled back to $to (${mode})"
log "serving $to"
