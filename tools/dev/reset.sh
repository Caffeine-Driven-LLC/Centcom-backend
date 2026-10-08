#!/usr/bin/env bash
# pnpm dev:reset (B012): stops the local stack, removes its named volumes (every row, object and
# mail in it), then runs up.sh, which brings it back to the seeded state. .env.local is kept.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dev_compose down --volumes --remove-orphans
echo "Dev stack wiped; starting it again."
exec bash "$(dirname "${BASH_SOURCE[0]}")/up.sh"
