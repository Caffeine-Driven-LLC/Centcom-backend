# Shared by the backup and restore scripts (B099). Sourced, never run.
#
# Settings come from the environment first, then from infra/deploy/production.env (or
# DEPLOY_ENV_FILE): BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID,
# BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_REGION (default "auto", which Cloudflare R2 wants; Backblaze
# B2 wants its region such as us-west-004) and BACKUP_PASSPHRASE.
#
# Needs on the host: bash, docker, gpg, curl 7.75 or newer, sha256sum. Nothing is installed in the
# containers. The passphrase and the S3 secret never appear on a command line (gpg reads the
# passphrase from a file descriptor, curl its credentials from stdin).

DR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../deploy/lib.sh
source "$DR_DIR/../deploy/lib.sh"

# Exit codes shared by the scripts.
EXIT_NODECRYPT=3 EXIT_VERIFY=4 EXIT_RTO=5

log() { printf '%s dr: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# cfg KEY [default]: environment, then the settings file, then the default.
cfg() {
  local value="${!1:-}"
  if [[ -z "$value" && -f "$ENV_FILE" ]]; then value="$(env_value "$1")"; fi
  printf '%s' "${value:-${2:-}}"
}

need_cfg() {
  local key
  for key in "$@"; do
    [[ -n "$(cfg "$key")" ]] || die "$EXIT_USAGE" "$key is not set (environment or $ENV_FILE)"
  done
}

need_tools() {
  local tool
  for tool in docker gpg curl sha256sum; do
    command -v "$tool" >/dev/null || die "$EXIT_USAGE" "$tool is required on this host"
  done
}

# ---- Postgres ---------------------------------------------------------------------------------
# The database to back up: the compose stack's postgres, or any container named by DR_PG_CONTAINER
# (running Postgres with user centcom and database centcom).
pg() {
  if [[ -n "${DR_PG_CONTAINER:-}" ]]; then
    docker exec -i "$DR_PG_CONTAINER" "$@"
  else
    compose exec -T postgres "$@"
  fi
}
psql_src() { pg psql --username=centcom --dbname=centcom --no-psqlrc --quiet --tuples-only --no-align -v ON_ERROR_STOP=1 "$@"; }

# ---- gpg (symmetric, AES-256, integrity-protected) -----------------------------------------------
# encrypt: plaintext on stdin, ciphertext on stdout.  decrypt: the reverse; exits non-zero (and
# writes nothing usable) when the passphrase is wrong or the data was altered.
gpg_common=(--batch --yes --quiet --no-tty --pinentry-mode loopback --no-options --no-autostart)
encrypt() {
  local pass
  pass="$(cfg BACKUP_PASSPHRASE)"
  [[ -n "$pass" ]] || die "$EXIT_USAGE" "BACKUP_PASSPHRASE is not set"
  gpg "${gpg_common[@]}" --symmetric --cipher-algo AES256 --compress-algo none \
    --s2k-mode 3 --s2k-count 65011712 --passphrase-fd 3 --output - 3< <(printf '%s' "$pass")
}
decrypt() {
  local pass
  pass="$(cfg BACKUP_PASSPHRASE)"
  [[ -n "$pass" ]] || die "$EXIT_USAGE" "BACKUP_PASSPHRASE is not set"
  gpg "${gpg_common[@]}" --decrypt --passphrase-fd 3 --output - 3< <(printf '%s' "$pass")
}

# ---- S3 (path style, SigV4 through curl; works with R2, B2, MinIO and AWS) --------------------------
s3_url() { printf '%s/%s/%s' "$(cfg BACKUP_S3_ENDPOINT | sed 's#/*$##')" "$(cfg BACKUP_S3_BUCKET)" "${1:-}"; }

# s3 METHOD KEY [curl args...]: the signed request; the reply body goes to stdout.
s3() {
  local method="$1" key="$2"
  shift 2
  curl --silent --show-error --fail-with-body --retry 3 --retry-delay 2 --connect-timeout 15 \
    --aws-sigv4 "aws:amz:$(cfg BACKUP_S3_REGION auto):s3" -K <(printf 'user = "%s:%s"\n' \
      "$(cfg BACKUP_S3_ACCESS_KEY_ID)" "$(cfg BACKUP_S3_SECRET_ACCESS_KEY)") \
    --request "$method" "$@" "$(s3_url "$key")"
}

# s3_put KEY FILE: uploads FILE; the payload hash is signed, so the store rejects a corrupted upload.
s3_put() {
  local sha
  sha="$(sha256sum "$2" | cut -d' ' -f1)"
  s3 PUT "$1" --upload-file "$2" --header "x-amz-content-sha256: $sha" >/dev/null
}
s3_get() { s3 GET "$1" --output "$2" >/dev/null; }
s3_delete() { s3 DELETE "$1" >/dev/null; }

# s3_list PREFIX: "key<TAB>last-modified" lines, newest last (ListObjectsV2, up to 1000 keys).
s3_list() {
  local xml
  xml="$(s3 GET "" --get --data-urlencode "list-type=2" --data-urlencode "prefix=$1")"
  printf '%s' "$xml" | sed 's/</\n</g' | awk '
    /^<Key>/ { key = substr($0, 6) }
    /^<LastModified>/ { print key "\t" substr($0, 15) }' | sort -t$'\t' -k2
}

# ISO 8601 UTC time to epoch seconds.
epoch() { date -u -d "$1" +%s; }
