#!/usr/bin/env bash
# Restores a backup made by backup.sh (B099).
#
#   infra/dr/restore.sh --latest | --key <db/centcom-....dump.gpg> | --file <local .dump.gpg>
#                       [--into fresh|stack] [--keep] [--report <file>]
#                       [--i-know-deletions-may-reappear] [--skip-safety-copy]
#
#   --into fresh   (default) a throwaway Postgres container with NO network, so nothing can reach
#                  production from it. It is removed when the script ends unless --keep; with --keep
#                  its name is printed. This is what the drill and any rehearsal use.
#   --into stack   replaces the live database of this server (stops api, worker, relay, caddy,
#                  drops and recreates the database, starts the services). Everything written
#                  since the backup is lost, and so is every account deletion made since then:
#                  deleted accounts are back until their deletion is requested again. That is a
#                  privacy incident to handle (infra/runbooks/dr/restore-database.md), so the
#                  script refuses unless --i-know-deletions-may-reappear is given. The current
#                  database is dumped first (pre-before-restore-*.dump in the postgres container's
#                  /backups) so a failed restore can be undone; --skip-safety-copy leaves that out
#                  (only for a database too damaged to dump).
#
# The ciphertext is checked against the manifest's SHA-256 first, then decrypted into pg_restore
# through a pipe (plaintext never lands on disk). A wrong passphrase or altered data stops the run
# before any database is touched or changed: exit 3. After the restore, verify.sh runs.
#
# Exit codes: 0 restored and verified; 1 a step failed; 2 usage; 3 cannot decrypt; 4 verification
# failed; 6 the credential scan quarantined the restore.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

key="" file="" into=fresh keep=0 report="" ack=0 latest=0 safety=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest) latest=1; shift ;;
    --key) key="${2:?}"; shift 2 ;;
    --file) file="${2:?}"; shift 2 ;;
    --into) into="${2:?}"; shift 2 ;;
    --keep) keep=1; shift ;;
    --report) report="${2:?}"; shift 2 ;;
    --i-know-deletions-may-reappear) ack=1; shift ;;
    --skip-safety-copy) safety=0; shift ;;
    -h | --help) sed -n '2,33p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
need_tools
need_cfg BACKUP_PASSPHRASE
[[ "$into" == fresh || "$into" == stack ]] || die "$EXIT_USAGE" "--into is fresh or stack"
if [[ "$into" == stack && $ack -eq 0 ]]; then
  die "$EXIT_USAGE" "restoring into the live stack brings back accounts deleted since the backup; read infra/runbooks/dr/restore-database.md and pass --i-know-deletions-may-reappear"
fi
[[ $latest -eq 1 || -n "$key" || -n "$file" ]] || die "$EXIT_USAGE" "choose --latest, --key or --file"

work="$(mktemp -d "${TMPDIR:-/tmp}/centcom-restore.XXXXXX")"
chmod 700 "$work"
target=""
cleanup() {
  rm -rf "$work"
  if [[ -n "$target" && $keep -eq 0 && "$into" == fresh ]]; then docker rm -f "$target" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
started=$SECONDS

# 1. fetch the ciphertext and its manifest
if [[ -n "$file" ]]; then
  dump="$file"
  manifest="${file%.dump.gpg}.manifest.json"
  [[ -f "$dump" && -f "$manifest" ]] || die "$EXIT_USAGE" "$dump and $manifest must both exist"
else
  need_cfg BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
  if [[ $latest -eq 1 ]]; then
    key="$(s3_list db/ | awk -F'\t' '$1 ~ /\.dump\.gpg$/ { k = $1 } END { print k }')"
    [[ -n "$key" ]] || die 1 "no backup found in the bucket"
  fi
  dump="$work/$(basename "$key")"
  manifest="$work/$(basename "${key%.dump.gpg}").manifest.json"
  log "download $key"
  s3_get "$key" "$dump"
  s3_get "${key%.dump.gpg}.manifest.json" "$manifest"
fi

# 2. integrity: the ciphertext is the one the manifest describes
want_sha="$(tr -d '\n' <"$manifest" | sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p')"
[[ -n "$want_sha" ]] || die 1 "the manifest has no SHA-256"
got_sha="$(sha256sum "$dump" | cut -d' ' -f1)"
[[ "$got_sha" == "$want_sha" ]] || die 1 "the backup does not match its manifest (SHA-256 differs): it was altered or the download is damaged"

# 3. the passphrase works: decrypt to nowhere first, so a wrong key stops the run before any change
log "checking the passphrase"
if ! decrypt <"$dump" >/dev/null 2>"$work/gpg.err"; then
  die "$EXIT_NODECRYPT" "cannot decrypt the backup: wrong BACKUP_PASSPHRASE, or the file is damaged"
fi

# 4. the target
if [[ "$into" == fresh ]]; then
  target="centcom-dr-$(date -u +%H%M%S)-$RANDOM"
  log "starting an isolated Postgres ($target, no network)"
  docker run -d --name "$target" --network none -e POSTGRES_USER=centcom -e POSTGRES_PASSWORD=drill \
    -e POSTGRES_DB=centcom "${DR_POSTGRES_IMAGE:-postgres:16}" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$target" pg_isready --username=centcom --dbname=centcom >/dev/null 2>&1 && break
    sleep 1
  done
  # the entrypoint restarts the server once after initdb; wait until it stays up
  sleep 2
  docker exec "$target" pg_isready --username=centcom --dbname=centcom >/dev/null || die 1 "the throwaway Postgres did not start"
  run_in_target() { docker exec -i "$target" "$@"; }
else
  preflight_env
  export TAG="${TAG:-$(state_get current-tag)}"
  log "stopping api, worker, relay and caddy"
  compose stop api worker relay caddy >/dev/null
  if [[ $safety -eq 1 ]]; then safety_copy; else ensure_postgres; fi
  compose exec -T postgres dropdb --username=centcom --force --if-exists centcom
  compose exec -T postgres createdb --username=centcom centcom
  target="$(compose ps -q postgres)"
  run_in_target() { docker exec -i "$target" "$@"; }
fi

# 5. restore through a pipe
log "restoring"
set +e
decrypt <"$dump" | backup_scan "restore/$(basename "$dump")" | run_in_target pg_restore --username=centcom --dbname=centcom --no-owner --exit-on-error
statuses=("${PIPESTATUS[@]}")
set -e
[[ "${statuses[0]}" -eq 0 ]] || die "$EXIT_NODECRYPT" "cannot decrypt the dump"
[[ "${statuses[2]}" -eq 0 ]] || die 1 "pg_restore failed"
if [[ "${statuses[1]}" -eq 3 ]]; then
  die "$EXIT_QUARANTINE" "the restored data holds a provider credential (or could not be scanned to the end): the restore is quarantined, do not put it in service"
fi

# 6. verify
log "verifying"
verdict=0
verify_out="$("$DR_DIR/verify.sh" --container "$target" --manifest "$manifest")" || verdict=$?
printf '%s\n' "$verify_out" >&2
checks="$(printf '%s\n' "$verify_out" | tail -n 1)"

if [[ "$into" == stack ]]; then
  if [[ $verdict -eq 0 ]]; then
    log "starting the services"
    compose up --detach --no-deps --wait --wait-timeout "${DEPLOY_WAIT_S:-120}" api worker relay caddy >/dev/null
    state_event "database restored from backup $(basename "$dump")"
  else
    log "verification failed: the services stay stopped"
  fi
fi

seconds=$((SECONDS - started))
if [[ -n "$report" ]]; then
  printf '{"restored_from":"%s","into":"%s","seconds":%s,"verified":%s,"checks":%s}\n' \
    "$(basename "$dump")" "$into" "$seconds" "$([[ $verdict -eq 0 ]] && echo true || echo false)" "${checks:-[]}" >"$report"
fi
if [[ $keep -eq 1 && "$into" == fresh ]]; then log "kept container $target"; printf '%s\n' "$target"; fi
log "done in ${seconds}s (verified: $([[ $verdict -eq 0 ]] && echo yes || echo NO))"
exit "$verdict"
