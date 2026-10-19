#!/usr/bin/env bash
# A base backup for point-in-time recovery (B099): the whole data directory as one tar, taken while Postgres runs
# (`pg_basebackup`, no WAL included: the archived segments cover the time after it), encrypted with the backup
# passphrase and uploaded to `base/<stamp>.tar.gz.gpg` with a small manifest `base/<stamp>.json`. Run it daily or
# weekly from cron; restoring to a moment needs the newest base backup from before that moment and every WAL
# segment since (wal-ship.sh). Plaintext never touches the disk.
#
#   infra/dr/basebackup.sh
#
# Exit codes: 0 uploaded; 1 failed; 2 usage or missing settings.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ "${1:-}" == -h || "${1:-}" == --help ]] && { sed -n '2,10p' "$0"; exit 0; }
need_tools
need_cfg BACKUP_PASSPHRASE BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
work="$(mktemp -d "${TMPDIR:-/tmp}/centcom-base.XXXXXX")"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

log "base backup"
pg pg_basebackup --username=centcom --pgdata=- --format=tar --gzip --checkpoint=fast --wal-method=none --no-password \
  | encrypt >"$work/base.gpg"
[[ -s "$work/base.gpg" ]] || die 1 "pg_basebackup produced nothing"
sha="$(sha256sum "$work/base.gpg" | cut -d' ' -f1)"
size="$(stat -c %s "$work/base.gpg")"
version="$(psql_src -c 'show server_version;' | head -n 1)"
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"stamp":"%s","started_at":"%s","finished_at":"%s","sha256":"%s","bytes":%s,"postgres":"%s"}\n' \
  "$stamp" "$started" "$finished" "$sha" "$size" "$version" >"$work/base.json"
s3_put "base/$stamp.tar.gz.gpg" "$work/base.gpg"
s3_put "base/$stamp.json" "$work/base.json"
state_set base-last "$(date +%s)"
log "base backup base/$stamp.tar.gz.gpg uploaded ($size bytes)"
