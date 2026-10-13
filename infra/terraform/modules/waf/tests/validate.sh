#!/usr/bin/env bash
# terraform fmt + validate of the waf module in a throwaway container (B097). Needs Docker and
# the Terraform registry (it downloads the Cloudflare provider schema); no account or token.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker run --rm --entrypoint sh -v "$PWD:/m:ro" hashicorp/terraform:1.9 -c '
  cp -r /m /tmp/w && cd /tmp/w &&
  terraform fmt -check -recursive &&
  terraform init -backend=false -input=false >/dev/null &&
  terraform validate'
