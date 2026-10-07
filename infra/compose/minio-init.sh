#!/usr/bin/env bash
# Creates the local stack's buckets (B012): the ones the R2 account has (B091), minus backups.
# tools/dev/up.sh runs it inside the minio container once the server is healthy:
#
#   docker compose exec -T minio bash /opt/centcom/minio-init.sh
#
# It speaks plain S3 (curl with SigV4), not MinIO's admin API, so it works against any
# S3-compatible server. Safe to run again: a bucket that exists is left as it is.
set -euo pipefail

ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
ACCESS_KEY="${MINIO_ROOT_USER:?MINIO_ROOT_USER is not set}"
SECRET_KEY="${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is not set}"
BUCKETS=(history snapshots exports releases)

# Prints the HTTP status of a signed S3 request: METHOD BUCKET.
s3() {
  curl --silent --output /dev/null --write-out '%{http_code}' \
    --aws-sigv4 'aws:amz:us-east-1:s3' --user "$ACCESS_KEY:$SECRET_KEY" \
    --request "$1" "$ENDPOINT/$2"
}

for bucket in "${BUCKETS[@]}"; do
  case "$(s3 HEAD "$bucket")" in
    200) echo "bucket $bucket: exists" ;;
    404)
      status="$(s3 PUT "$bucket")"
      if [[ "$status" != 200 ]]; then
        echo "bucket $bucket: create failed with HTTP $status" >&2
        exit 1
      fi
      echo "bucket $bucket: created"
      ;;
    *)
      echo "bucket $bucket: the S3 endpoint answered HTTP $(s3 HEAD "$bucket")" >&2
      exit 1
      ;;
  esac
done
