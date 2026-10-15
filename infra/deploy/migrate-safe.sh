#!/usr/bin/env bash
# Applies the pending database migrations with a safety net (B092):
#
#   1. shows what is pending (centcom-db status) and stops if there is nothing;
#   2. runs migration-lint.mjs on the pending files (each must work with the release still running);
#      on a database that already has data, refuses a pending "-- contract" migration (one that may
#      drop data) unless --allow-contract;
#   3. dumps the database to /backups/pre-<tag>-<time>.dump and reads the dump back;
#   4. applies the migrations (each file runs in its own transaction, under an advisory lock).
#
# The services keep running the old code meanwhile, which is safe because every migration is an
# "expand" step the previous release works with (packages/db/CONVENTIONS.md). If a migration fails,
# nothing is changed beyond the files that already committed; the dump is the way back
# (rollback.sh --restore-db <dump>).
#
#   infra/deploy/migrate-safe.sh [--tag <tag>] [--allow-contract] [--dry-run]
#
# Exit codes: 0 done or nothing to do; 1 a step failed; 2 usage or incomplete settings;
# 3 a contract migration is pending and --allow-contract was not given; 4 a pending migration
# fails migration-lint.mjs.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag="${TAG:-local}" allow_contract=0 dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
    --allow-contract) allow_contract=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
export TAG="$tag"

preflight_env
ensure_postgres

log "migration status"
status="$(compose run --rm --no-deps -T migrate node node_modules/@centcom/db/dist/cli.js status)" \
  || { printf '%s\n' "$status" >&2; die 1 "centcom-db status failed (a CHANGED or OUT OF ORDER file blocks every deploy)"; }
printf '%s\n' "$status" | tail -n 5
mapfile -t pending < <(printf '%s\n' "$status" | awk '$1 == "pending" { print $2 ".sql" }')
if [[ ${#pending[@]} -eq 0 ]]; then
  log "nothing to migrate"
  exit 0
fi
log "${#pending[@]} pending: ${pending[*]}"

# A "-- contract" phase marker on a line of its own (as packages/db lintMigration reads it). A
# database with nothing applied yet is new: there is no data a contract step could drop.
contract=()
if ! printf '%s\n' "$status" | tail -n 1 | grep -q '^0 applied'; then
  for file in "${pending[@]}"; do
    if compose run --rm --no-deps -T --entrypoint grep migrate -qiE \
      '^[[:space:]]*--[[:space:]]*contract([[:space:]]+phase)?[[:space:]]*[:.-]?[[:space:]]*$' \
      "node_modules/@centcom/db/migrations/$file"; then
      contract+=("$file")
    fi
  done
fi
# Every pending migration must work with the release still running (migration-lint.mjs: no rename,
# no NOT NULL without a default, no index build that locks an existing table, destructive steps
# only after a "-- contract" marker).
# A new database (nothing applied) runs no release yet, so there is nothing to break.
if ! printf '%s\n' "$status" | tail -n 1 | grep -q '^0 applied'; then
  lint_files=()
  for file in "${pending[@]}"; do lint_files+=("$REPO_DIR/packages/db/migrations/$file"); done
  if ! node "$DEPLOY_DIR/migration-lint.mjs" "${lint_files[@]}"; then
    die "$EXIT_UNSAFE_MIGRATION" "a pending migration would break the release still running (above); split it into expand and contract releases"
  fi
fi

if [[ ${#contract[@]} -gt 0 && $allow_contract -eq 0 ]]; then
  die "$EXIT_CONTRACT" "pending contract migration(s) may drop data: ${contract[*]}; check the previous release no longer uses it, then re-run with --allow-contract"
fi
if [[ $dry_run -eq 1 ]]; then
  log "dry run: would back up and apply ${#pending[@]} migration(s)"
  exit 0
fi

log "backing up before migrating"
backup="$(pg_backup "$tag")"
state_set last-backup "$backup"
state_event "backup $backup before migrating (tag $tag)"
log "backup written: /backups/$backup"

log "applying migrations"
if ! compose run --rm --no-deps -T migrate; then
  state_event "migrate failed (tag $tag), backup $backup"
  die 1 "migration failed; the database holds only the files that committed. Restore with: infra/deploy/rollback.sh --restore-db $backup"
fi
state_event "migrated (tag $tag)"
log "migrations applied"
