#!/usr/bin/env bash
# Deletes backups older than BACKUP_RETENTION_DAYS (B099; default and maximum 35, so the time a
# deleted account can persist in a backup is bounded), keeping the newest three whatever their age.
#
#   infra/dr/prune.sh [--dry-run]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dry=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry=1; shift ;;
    -h | --help) sed -n '2,6p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
need_tools
need_cfg BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
days="$(cfg BACKUP_RETENTION_DAYS 35)"
[[ "$days" =~ ^[0-9]+$ && "$days" -ge 1 && "$days" -le 35 ]] || die "$EXIT_USAGE" "BACKUP_RETENTION_DAYS must be 1 to 35 (got: $days)"
# DR_NOW_EPOCH is for tests: the time the age of a backup is measured against.
cutoff=$(( ${DR_NOW_EPOCH:-$(date -u +%s)} - days * 86400 ))

mapfile -t dumps < <(s3_list db/ | awk -F'\t' '$1 ~ /\.dump\.gpg$/')
total=${#dumps[@]}
removed=0
for ((i = 0; i < total - 3; i++)); do
  key="${dumps[i]%%$'\t'*}"
  modified="${dumps[i]##*$'\t'}"
  if (( $(epoch "$modified") < cutoff )); then
    log "prune $key (from $modified)"
    if [[ $dry -eq 0 ]]; then
      s3_delete "$key"
      s3_delete "${key%.dump.gpg}.manifest.json"
    fi
    removed=$((removed + 1))
  fi
done
log "$removed of $total backups $([[ $dry -eq 1 ]] && echo 'would be ')removed (limit $days days, newest 3 kept)"
