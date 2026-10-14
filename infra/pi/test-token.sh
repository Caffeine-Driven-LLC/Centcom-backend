#!/usr/bin/env bash
# For SCRIPTED CHECKS against the test server only (B112): prints a web-app access token for a user and device, as
# `pnpm dev:token` does for the dev stack, by running the API image's dev-token tool as a one-off container with
# NODE_ENV=development. It lets `pnpm dev:branch-check` run without a browser for the "team" step; it is a
# back door that needs access to this machine's Docker, which is why it lives with the test server.
#
#   infra/pi/test-token.sh <usr_ id> <dev_ id>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ $# -eq 2 ]] || die 2 "usage: test-token.sh <usr_ id> <dev_ id>"
[[ -f "$ENV_FILE" ]] || die 1 "no settings at $ENV_FILE: run up.sh first"
PI_PROJECT="$(env_value PI_PROJECT)"; PI_PROJECT="${PI_PROJECT:-centcom-pi}"; export PI_PROJECT
load_profiles
compose run --rm --no-deps -T -e NODE_ENV=development api node dist/dev-token.js "$1" "$2" 2>/dev/null | tail -n 1
