#!/usr/bin/env bash
# Follows the logs of the test server (B112): all services, or the ones named.   infra/pi/logs.sh [service...]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ -f "$ENV_FILE" ]] || die 1 "no settings at $ENV_FILE: up.sh has not been run here"
PI_PROJECT="$(env_value PI_PROJECT)"; PI_PROJECT="${PI_PROJECT:-centcom-pi}"; export PI_PROJECT
load_profiles
compose logs --follow --tail 100 "$@"
