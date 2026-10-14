#!/usr/bin/env bash
# Back to a clean slate (B112): stops this stack and deletes its data (database, object store, mail, the
# certificate authority is kept unless --new-secrets) and nothing else on the machine: only this compose project's
# containers, network and volumes. Then run up.sh again.
#
#   infra/pi/reset.sh [--new-secrets] [--yes]
#
#   --new-secrets  also deletes infra/pi/.state (passwords, signing key, settings) and the CA, so up.sh makes new
#                  ones. Every device that trusted the old CA must trust the new one.
#   --yes          do not ask.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
new_secrets=0 yes=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new-secrets) new_secrets=1; shift ;;
    --yes) yes=1; shift ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die 2 "unknown option $1" ;;
  esac
done
[[ -f "$ENV_FILE" ]] || die 1 "no settings at $ENV_FILE: nothing to reset"
PI_PROJECT="$(env_value PI_PROJECT)"; PI_PROJECT="${PI_PROJECT:-centcom-pi}"; export PI_PROJECT
if [[ $yes -eq 0 ]]; then
  read -r -p "Delete ALL data of the Centcom test server '$PI_PROJECT' (accounts, sessions, mail)? [y/N] " answer
  [[ "$answer" == y || "$answer" == Y ]] || die 1 "cancelled"
fi
PI_PROFILES="lan tunnel"; export PI_PROFILES
if [[ $new_secrets -eq 1 ]]; then
  compose down --volumes --remove-orphans
  rm -rf "$STATE_DIR"
  log "removed the data, the secrets and the CA of project $PI_PROJECT; up.sh makes new ones"
else
  # keep the certificate authority so devices need not trust a new one: remove every volume but caddy-data
  compose down --remove-orphans
  for v in postgres-data minio-data caddy-config; do docker volume rm -f "${PI_PROJECT}_$v" >/dev/null 2>&1 || true; done
  log "removed the data of project $PI_PROJECT (secrets and CA kept); up.sh starts a clean server"
fi
