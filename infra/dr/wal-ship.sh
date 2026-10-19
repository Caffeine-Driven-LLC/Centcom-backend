#!/usr/bin/env bash
# Ships the archived WAL segments to the backup bucket (B099, point-in-time recovery).
#
#   infra/dr/wal-ship.sh
#
# Postgres (with PG_ARCHIVE_MODE=on) copies every finished WAL segment, and at least one a minute, into the
# `wal-archive` volume. This script, run from cron every minute (crontab.example), encrypts each file with the
# backup passphrase, uploads it to `wal/<segment>.gpg`, downloads it again and compares it with what was sent, and
# only then deletes it from the volume. A segment that cannot be shipped stays where it is and is tried again; the
# exit code is 1 and the number waiting is printed, so a stuck shipper shows up (and the volume filling is the
# reason PG_ARCHIVE_MODE stays off until this runs).
#
# With this and a base backup (basebackup.sh) the data lost in a disaster is at most the segment that was not
# shipped yet: about two minutes, instead of up to 26 hours with the nightly dump alone.
#
# Exit codes: 0 everything shipped (or nothing to ship); 1 something is waiting; 2 usage or missing settings.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ "${1:-}" == -h || "${1:-}" == --help ]] && { sed -n '2,17p' "$0"; exit 0; }
need_tools
need_cfg BACKUP_PASSPHRASE BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

work="$(mktemp -d "${TMPDIR:-/tmp}/centcom-wal.XXXXXX")"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

# Segments (24 hex digits) and the small .backup history files; never a partial copy (*.tmp).
mapfile -t files < <(pg sh -c 'ls -1 /wal 2>/dev/null' | grep -E '^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?$' | sort || true)
shipped=0 waiting=0
for f in "${files[@]}"; do
  [[ -n "$f" ]] || continue
  if pg cat "/wal/$f" | encrypt >"$work/up.gpg" \
    && s3_put "wal/$f.gpg" "$work/up.gpg" \
    && s3_get "wal/$f.gpg" "$work/down.gpg" \
    && cmp -s "$work/up.gpg" "$work/down.gpg"; then
    pg rm -f "/wal/$f"
    shipped=$((shipped + 1))
  else
    log "could not ship $f; it stays in the archive volume"
    waiting=$((waiting + 1))
  fi
done
state_set wal-last-run "$(date +%s)"
[[ $shipped -eq 0 ]] || state_set wal-last-shipped "$(date +%s)"
log "wal: shipped $shipped, waiting $waiting"
[[ $waiting -eq 0 ]]
