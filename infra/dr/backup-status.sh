#!/usr/bin/env bash
# How old is the newest backup? (B099 "backup-verify")
#
#   infra/dr/backup-status.sh [--prom <file>]
#
# Prints `backup_age_seconds <n>` for the newest encrypted dump in the bucket and exits 1 when it is
# older than BACKUP_MAX_AGE_S (default 93600 = 26 h) or there is none. With --prom it also writes the
# gauge in Prometheus text format for node_exporter's textfile collector:
#   centcom_backup_age_seconds, centcom_backup_count, centcom_backup_last_drill_age_days (from the
#   drill report named by DR_DRILL_REPORT, if it exists). Run it from cron every 15 minutes.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

prom=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prom) prom="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
need_tools
need_cfg BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
max_age="$(cfg BACKUP_MAX_AGE_S 93600)"

listing="$(s3_list db/ | awk -F'\t' '$1 ~ /\.dump\.gpg$/')"
count="$(printf '%s' "$listing" | grep -c . || true)"
age=-1
if [[ "$count" -gt 0 ]]; then
  age=$(( $(date -u +%s) - $(epoch "$(printf '%s\n' "$listing" | tail -n 1 | cut -f2)") ))
fi
echo "backup_age_seconds $age"
echo "backup_count $count"

if [[ -n "$prom" ]]; then
  drill_age=-1
  report="$(cfg DR_DRILL_REPORT "$PWD/dr-drill-report.json")"
  if [[ -f "$report" ]]; then drill_age=$(( ($(date -u +%s) - $(stat -c %Y "$report")) / 86400 )); fi
  {
    echo "# TYPE centcom_backup_age_seconds gauge"
    echo "centcom_backup_age_seconds $age"
    echo "# TYPE centcom_backup_count gauge"
    echo "centcom_backup_count $count"
    echo "# TYPE centcom_backup_last_drill_age_days gauge"
    echo "centcom_backup_last_drill_age_days $drill_age"
  } >"$prom.tmp" && mv "$prom.tmp" "$prom"
fi
if [[ "$age" -lt 0 || "$age" -gt "$max_age" ]]; then
  die 1 "the newest backup is $([[ $age -lt 0 ]] && echo missing || echo "${age}s old"); the limit is ${max_age}s"
fi
