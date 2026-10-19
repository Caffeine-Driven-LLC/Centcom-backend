#!/usr/bin/env bash
# Point-in-time restore (B099): the newest base backup from before the target, every archived WAL segment, and
# Postgres' own recovery to the moment you name, in a throwaway container with NO network (nothing can reach
# production from it).
#
#   infra/dr/pitr-restore.sh --to '2026-10-14 09:58:00+00' [--base <base/....tar.gz.gpg>] [--keep]
#   infra/dr/pitr-restore.sh --to latest [--keep]       replay everything that was shipped
#
# The time must be later than the end of the base backup it uses (Postgres refuses an earlier one) and no later
# than the last shipped segment. With --keep the container is left running and its name printed on the last line;
# connect with `docker exec -it <name> psql -U centcom centcom`. Without it the restore is checked
# (Postgres promoted and answers) and removed.
#
# Reads the encrypted objects with the backup passphrase; a wrong passphrase stops it before anything starts.
# After a real disaster, `pnpm tombstones:apply` re-deletes the workspaces purged since the base backup.
#
# Exit codes: 0 recovered and answering; 1 failed; 2 usage; 3 cannot decrypt.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

to="" base="" keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) to="${2:?--to needs a time or 'latest'}"; shift 2 ;;
    --base) base="${2:?--base needs a key}"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "$EXIT_USAGE" "unknown option $1" ;;
  esac
done
[[ -n "$to" ]] || die "$EXIT_USAGE" "--to <time|latest> is required"
if [[ "$to" != latest ]]; then
  [[ "$to" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9:.]+([+-][0-9]{2}(:?[0-9]{2})?|Z)$ ]] \
    || die "$EXIT_USAGE" "--to must look like '2026-10-14 09:58:00+00' (with a time zone), or 'latest'"
fi
need_tools
need_cfg BACKUP_PASSPHRASE BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY

work="$(mktemp -d "${TMPDIR:-/tmp}/centcom-pitr.XXXXXX")"
chmod 700 "$work"
suffix="$$-$(date +%s)"
vol_data="centcom-pitr-data-$suffix" vol_wal="centcom-pitr-wal-$suffix" target="centcom-pitr-$suffix"
cleanup() {
  rm -rf "$work"
  if [[ $keep -eq 0 ]]; then
    docker rm -f "$target" >/dev/null 2>&1 || true
    docker volume rm -f "$vol_data" "$vol_wal" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
image="postgres:16"

# 1. the base backup: the newest whose manifest says it started before the target
if [[ -z "$base" ]]; then
  target_epoch=$(date -u +%s)
  [[ "$to" == latest ]] || target_epoch="$(epoch "$to")"
  while IFS=$'\t' read -r key _; do
    [[ "$key" == base/*.json ]] || continue
    s3_get "$key" "$work/m.json"
    started_at="$(sed -n 's/.*"started_at":"\([^"]*\)".*/\1/p' "$work/m.json")"
    [[ -n "$started_at" && "$(epoch "$started_at")" -le "$target_epoch" ]] && base="${key%.json}.tar.gz.gpg"
  done < <(s3_list base/)
fi
[[ -n "$base" ]] || die 1 "no base backup from before $to in the bucket (run basebackup.sh)"
log "base backup $base"

# 2. unpack it into a volume (decrypting through a pipe; a wrong passphrase stops here)
docker volume create "$vol_data" >/dev/null
docker volume create "$vol_wal" >/dev/null
s3_get "$base" "$work/base.gpg"
decrypt <"$work/base.gpg" >"$work/base.tar.gz" || die "$EXIT_NODECRYPT" "cannot decrypt the base backup (wrong BACKUP_PASSPHRASE or altered data)"
docker run --rm -i -v "$vol_data:/d" "$image" sh -c 'tar xzf - -C /d && chown -R postgres:postgres /d && chmod 700 /d' <"$work/base.tar.gz"
rm -f "$work/base.tar.gz" "$work/base.gpg"

# 3. every archived segment
count=0
while IFS=$'\t' read -r key _; do
  [[ "$key" == wal/*.gpg ]] || continue
  name="$(basename "$key" .gpg)"
  s3_get "$key" "$work/seg.gpg"
  decrypt <"$work/seg.gpg" | docker run --rm -i -v "$vol_wal:/wal" "$image" sh -c "cat > /wal/$name && chown postgres:postgres /wal/$name"
  count=$((count + 1))
done < <(s3_list wal/)
log "$count WAL files"

# 4. recovery settings, then start with no network
{
  echo "restore_command = 'cp /wal/%f %p'"
  [[ "$to" == latest ]] || echo "recovery_target_time = '$to'"
  echo "recovery_target_action = 'promote'"
} | docker run --rm -i -v "$vol_data:/d" "$image" sh -c 'touch /d/recovery.signal && cat >> /d/postgresql.auto.conf && chown postgres:postgres /d/recovery.signal /d/postgresql.auto.conf'
docker run -d --name "$target" --network none -v "$vol_data:/var/lib/postgresql/data" -v "$vol_wal:/wal:ro" "$image" >/dev/null

# 5. wait for recovery to finish and promote
for _ in $(seq 1 120); do
  state="$(docker exec "$target" psql -U centcom -d centcom -tAc 'select pg_is_in_recovery()' 2>/dev/null || true)"
  [[ "$state" == f ]] && break
  if [[ -z "$(docker ps -q -f name="$target")" ]]; then
    docker logs --tail 20 "$target" >&2 || true
    die 1 "the recovery container stopped; see the log above (is the target earlier than the base backup, or later than the last WAL?)"
  fi
  sleep 1
done
[[ "${state:-}" == f ]] || die 1 "recovery did not finish within 2 minutes"
log "recovered to ${to} and answering"
if [[ $keep -eq 1 ]]; then printf '%s\n' "$target"; fi
