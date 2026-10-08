#!/usr/bin/env bash
# pnpm dev:down (B012): stops the local stack and removes its containers. The named volumes, and so
# the data, stay; `pnpm dev:reset` removes them too.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dev_compose down --remove-orphans
echo "Dev stack stopped; its data is kept (pnpm dev:reset wipes it)."
