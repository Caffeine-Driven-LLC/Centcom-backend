#!/usr/bin/env bash
# Encrypted Postgres backup to an S3-compatible bucket (B099): Cloudflare R2, Backblaze B2, AWS.
#
#   infra/dr/backup.sh [--tag <deploy tag>] [--local-only <dir>]
#
# Takes one consistent snapshot of the database, and from that snapshot writes (1) a custom-format
# pg_dump, encrypted with gpg (AES-256, key from BACKUP_PASSPHRASE; the passphrase is never stored in
# the bucket or the repository) and (2) a manifest next to it: the newest migration, the row count
# and an md5 of every table, the size and SHA-256 of the ciphertext. Both are uploaded; the upload
# is signed with the payload hash, so a corrupted transfer is refused. Plaintext never touches the
# disk: pg_dump streams into gpg. Old backups are pruned by prune.sh (35 days at most).
#
# Run it from cron on the server (infra/dr/crontab.example). Exit codes: 0 uploaded; 1 a step
# failed; 2 usage or missing settings.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag="$(state_get current-tag)" local_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
    --local-only) local_dir="${2:?--local-only needs a folder}"; shift 2 ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
need_tools
need_cfg BACKUP_PASSPHRASE
[[ -n "$local_dir" ]] || need_cfg BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
work="$(mktemp -d "${TMPDIR:-/tmp}/centcom-backup.XXXXXX")"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

log "snapshot"
coproc SNAP { pg psql --username=centcom --dbname=centcom --no-psqlrc --quiet --tuples-only --no-align -v ON_ERROR_STOP=1; }
# snap_cmd SQL: runs SQL in the snapshot session and leaves its output in SNAP_OUT. It is called
# directly, never in $(...) or a pipeline: bash closes a coprocess's descriptors in subshells.
SNAP_OUT=""
snap_cmd() {
  local line
  SNAP_OUT=""
  printf '%s\n\\echo __END__\n' "$1" >&"${SNAP[1]}"
  while IFS= read -r -u "${SNAP[0]}" line; do
    [[ "$line" == __END__ ]] && break
    SNAP_OUT+="${SNAP_OUT:+$'\n'}$line"
  done
}
snap_cmd 'begin isolation level repeatable read read only;'
snap_cmd 'select pg_export_snapshot();'
snapshot_id="$SNAP_OUT"
[[ -n "$snapshot_id" ]] || die 1 "could not export a snapshot"

# Everything in the manifest is read from the same snapshot the dump uses.
snap_cmd "select coalesce(max(version), '') from schema_migrations;"
schema_version="$SNAP_OUT"
read -r -d '' tables_sql <<'SQL' || true
select coalesce(json_object_agg(t.table_name, json_build_object(
  'rows', (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::bigint,
  'md5',  (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, E''\n'' order by x::text), '''')) as h from %I.%I x', t.table_schema, t.table_name), false, true, '')))[1]::text
) order by t.table_name), '{}'::json)
from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE';
SQL
snap_cmd "$tables_sql"
tables_json="$SNAP_OUT"
snap_cmd 'show server_version;'
pg_server="$SNAP_OUT"

log "dump -> encrypt"
dump_file="$work/centcom-$stamp.dump.gpg"
pg pg_dump --username=centcom --dbname=centcom --format=custom --snapshot="$snapshot_id" --no-owner \
  | encrypt >"$dump_file"
printf 'rollback;\n\\q\n' >&"${SNAP[1]}"
wait "$SNAP_PID" 2>/dev/null || true

bytes="$(stat -c %s "$dump_file")"
[[ "$bytes" -gt 1024 ]] || die 1 "the encrypted dump is only $bytes bytes; refusing to upload it"
sha="$(sha256sum "$dump_file" | cut -d' ' -f1)"
key="db/centcom-$stamp.dump.gpg"
manifest="$work/centcom-$stamp.manifest.json"
cat >"$manifest" <<JSON
{"version":1,"created_at":"$started","tag":"${tag:-unknown}","pg_server":"$pg_server","schema_version":"$schema_version","encryption":"gpg-aes256","dump":{"key":"$key","bytes":$bytes,"sha256":"$sha"},"tables":$tables_json}
JSON

if [[ -n "$local_dir" ]]; then
  mkdir -p "$local_dir"
  cp "$dump_file" "$local_dir/" && cp "$manifest" "$local_dir/"
  log "kept in $local_dir (not uploaded)"
else
  log "upload $key (${bytes} bytes)"
  s3_put "$key" "$dump_file"
  s3_put "db/centcom-$stamp.manifest.json" "$manifest"
fi
state_event "backup $stamp ${bytes}B schema $schema_version"
printf '%s\n' "$key"
