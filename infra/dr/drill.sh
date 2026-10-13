#!/usr/bin/env bash
# Restore drill (B099): proves the backups can be restored, and how long that takes.
#
#   infra/dr/drill.sh [--use-latest] [--report <file>] [--no-negative]
#
#   1. backup.sh makes a fresh encrypted backup (or --use-latest takes the newest one in the bucket,
#      which measures the real recovery point of the last scheduled run);
#   2. restore.sh restores it into an isolated throwaway Postgres (no network), verifying the
#      migration version and every table's row count and md5 against the manifest;
#   3. the restored schema is diffed against the live one (a difference is reported, and fails the
#      drill unless a deploy ran in between);
#   4. negative checks: a wrong passphrase and an altered backup both stop before any database is
#      touched (exit 3 and 1);
#   5. dr-drill-report.json: {started_at, restore_point, rpo_seconds, rto_seconds, verified, checks}.
#
# rpo_seconds is the age of the restored backup when the drill started; rto_seconds is the time
# from download to a verified database. The drill fails (exit 5) when rto_seconds exceeds
# DR_RTO_TARGET_S (default 3600) or rpo_seconds exceeds DR_RPO_TARGET_S (default 93600: nightly
# backups plus two hours, the single-server layout's honest figure; the 300 s of the multi-server
# design needs WAL archiving).
#
# Exit codes: 0 verified within targets; 1 a step failed; 2 usage; 4 verification failed; 5 over target.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

use_latest=0 report="dr-drill-report.json" negative=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --use-latest) use_latest=1; shift ;;
    --report) report="${2:?}"; shift 2 ;;
    --no-negative) negative=0; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
need_tools
need_cfg BACKUP_PASSPHRASE BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
rto_target="$(cfg DR_RTO_TARGET_S 3600)" rpo_target="$(cfg DR_RPO_TARGET_S 93600)"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
work="$(mktemp -d "${TMPDIR:-/tmp}/centcom-drill.XXXXXX")"
chmod 700 "$work"
container=""
trap 'rm -rf "$work"; [[ -z "$container" ]] || docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
checks=()
add_check() { checks+=("{\"name\":\"$1\",\"ok\":$2}"); }

# 1. the backup to restore
if [[ $use_latest -eq 1 ]]; then
  key="$(s3_list db/ | awk -F'\t' '$1 ~ /\.dump\.gpg$/ { k = $1 } END { print k }')"
  [[ -n "$key" ]] || die 1 "no backup in the bucket"
else
  key="$("$DR_DIR/backup.sh" | tail -n 1)"
fi
log "restoring $key"
s3_get "${key%.dump.gpg}.manifest.json" "$work/manifest.json"
restore_point="$(sed -n 's/.*"created_at":"\([^"]*\)".*/\1/p' "$work/manifest.json")"
rpo_seconds=$(( $(date -u +%s) - $(epoch "$restore_point") ))

# 2. restore + verify into an isolated instance, timed
t0=$SECONDS
rc=0
container="$("$DR_DIR/restore.sh" --key "$key" --into fresh --keep --report "$work/restore.json" | tail -n 1)" || rc=$?
rto_seconds=$((SECONDS - t0))
verified=false
[[ $rc -eq 0 ]] && verified=true
add_check "restore into an isolated instance and verify against the manifest" "$verified"
if [[ -z "$container" ]]; then container=""; fi

# 3. schema equality with the live database
if [[ $rc -eq 0 && -n "$container" ]]; then
  pg pg_dump --username=centcom --dbname=centcom --schema-only --no-owner --no-comments >"$work/live.sql"
  docker exec -i "$container" pg_dump --username=centcom --dbname=centcom --schema-only --no-owner --no-comments >"$work/restored.sql"
  # Restoring re-parses CHECK expressions, which can change their parentheses ((a AND b) AND c
  # becomes a AND b AND c) without changing their meaning; compare those lines without parentheses.
  norm() { grep -v '^\\\(un\)\?restrict' "$1" | sed '/CHECK/ s/[()]//g'; }
  if diff <(norm "$work/live.sql") <(norm "$work/restored.sql") >"$work/schema.diff"; then
    add_check "restored schema equals the live schema" true
  else
    add_check "restored schema equals the live schema" false
    log "schema differs (a deploy since the backup?):"; head -20 "$work/schema.diff" >&2
  fi
fi

# 4. negative checks: nothing is touched when the key is wrong or the file is altered
if [[ $negative -eq 1 && $rc -eq 0 ]]; then
  copy="$work/copy.dump.gpg"
  s3_get "$key" "$copy"
  cp "$work/manifest.json" "$work/copy.manifest.json"
  nrc=0
  BACKUP_PASSPHRASE="not-the-passphrase-$RANDOM" "$DR_DIR/restore.sh" --file "$copy" --into fresh >/dev/null 2>&1 || nrc=$?
  add_check "a wrong passphrase stops with exit 3" "$([[ $nrc -eq $EXIT_NODECRYPT ]] && echo true || echo false)"
  # change one byte in the middle of the ciphertext
  size="$(stat -c %s "$copy")"
  printf '\xff' | dd of="$copy" bs=1 seek=$((size / 2)) conv=notrunc 2>/dev/null
  nrc=0
  "$DR_DIR/restore.sh" --file "$copy" --into fresh >/dev/null 2>&1 || nrc=$?
  add_check "an altered backup is refused before any restore" "$([[ $nrc -eq 1 ]] && echo true || echo false)"
fi

# 5. the report
all_ok=true
for c in "${checks[@]}"; do [[ "$c" == *'"ok":true}' ]] || all_ok=false; done
[[ "$all_ok" == true ]] || verified=false
(IFS=,; printf '{"started_at":"%s","restore_point":"%s","backup":"%s","rpo_seconds":%s,"rto_seconds":%s,"rto_target_seconds":%s,"rpo_target_seconds":%s,"verified":%s,"checks":[%s]}\n' \
  "$started_at" "$restore_point" "$key" "$rpo_seconds" "$rto_seconds" "$rto_target" "$rpo_target" "$verified" "${checks[*]}") >"$report"
state_event "restore drill: verified=$verified rto=${rto_seconds}s rpo=${rpo_seconds}s"
log "report: $report (rto ${rto_seconds}s of ${rto_target}s, rpo ${rpo_seconds}s of ${rpo_target}s, verified $verified)"

[[ "$verified" == true ]] || exit "$EXIT_VERIFY"
if (( rto_seconds > rto_target || rpo_seconds > rpo_target )); then
  die "$EXIT_RTO" "the drill passed but is over its target (rto ${rto_seconds}s/${rto_target}s, rpo ${rpo_seconds}s/${rpo_target}s)"
fi
