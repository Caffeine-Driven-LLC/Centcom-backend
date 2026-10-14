#!/usr/bin/env bash
# Stops what up.sh started (B112) and nothing else: the containers and the network of this compose project. The
# data (database, files, the CA) stays; up.sh starts it again. reset.sh removes the data.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[[ -f "$ENV_FILE" ]] || die 1 "no settings at $ENV_FILE: up.sh has not been run here"
PI_PROJECT="$(env_value PI_PROJECT)"; PI_PROJECT="${PI_PROJECT:-centcom-pi}"; export PI_PROJECT
PI_PROFILES="lan tunnel"; export PI_PROFILES # so every optional service of the project is included
compose down --remove-orphans
log "stopped project $PI_PROJECT (data kept)"
