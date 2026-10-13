#!/usr/bin/env bash
# For LOCAL DRILLS of the production stack only (B091): prints a web-app access token for a user
# and device, as `pnpm dev:token` does for the dev stack, by running the API image's dev-token
# tool as a one-off container with NODE_ENV=development. The tool refuses NODE_ENV=production, and
# so does this script's target: it exits 1 unless the settings file names a localhost
# PUBLIC_API_URL. `tools/dev/client-kit.ts` calls it when CENTCOM_APP_TOKEN_CMD points here.
#
#   DEPLOY_ENV_FILE=<settings> infra/deploy/drill-token.sh <usr_ id> <dev_ id>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ $# -eq 2 ]] || die "$EXIT_USAGE" "usage: drill-token.sh <usr_ id> <dev_ id>"
[[ "$(env_value PUBLIC_API_URL)" =~ ^http://(localhost|127\.0\.0\.1)[:/] ]] \
  || die 1 "refusing: PUBLIC_API_URL is not a localhost address, so this is not a local drill"
TAG="${TAG:-$(state_get current-tag)}" compose run --rm --no-deps -T -e NODE_ENV=development api \
  node dist/dev-token.js "$1" "$2" 2>/dev/null | tail -n 1
