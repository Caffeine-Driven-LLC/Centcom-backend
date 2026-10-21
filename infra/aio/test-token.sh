#!/usr/bin/env bash
# For SCRIPTED CHECKS against the test server only (B112): prints a web-app access token for a user and device, as
# `pnpm dev:token` does for the dev stack, by running the API's dev-token tool inside the container with
# NODE_ENV=development and the API's own signing key. A back door that needs this machine's Docker; it is why it
# lives with the test server and not in the image's entrypoint.
#
#   CENTCOM_APP_TOKEN_CMD=$PWD/infra/aio/test-token.sh pnpm dev:branch-check
#   infra/aio/test-token.sh <usr_ id> <dev_ id>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ $# -eq 2 ]] || die 2 "usage: test-token.sh <usr_ id> <dev_ id>"
is_ours "$AIO_NAME" || die 1 "no running Centcom test server named $AIO_NAME: run infra/aio/run.sh first"
docker exec "$AIO_NAME" bash -c 'source /run/centcom/api.env.sh; cd /app/api; exec gosu centcom env NODE_ENV=development SERVICE_NAME=api node dist/dev-token.js "$0" "$1"' "$1" "$2" 2>/dev/null | tail -n 1
