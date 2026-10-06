#!/usr/bin/env bash
# Refresh site/data from the client repo so the docs tables never drift from the product.
# Usage: site/tools/refresh-data.sh /path/to/Centcom
set -euo pipefail
C="${1:-../Centcom}"; D="$(cd "$(dirname "$0")/../data" && pwd)"
( cd "$C" && ./node_modules/.bin/tsx -e "
import { writeFileSync } from 'node:fs';
import { COMMANDS } from './packages/tui/src/state/commands.ts';
import { CLAUDE_MODELS } from './packages/agent/src/models.ts';
writeFileSync('$D/commands.json', JSON.stringify(COMMANDS, null, 1));
writeFileSync('$D/models.json', JSON.stringify(CLAUDE_MODELS, null, 1));
" --input-type=module 2>/dev/null || true )
python3 - "$C" "$D" <<'PY'
import json, sys, shutil
c, d = sys.argv[1], sys.argv[2]
s = json.load(open(f'{c}/plan/STATUS.json')); json.dump({'updated': s['updated'], 'next': s['next']}, open(f'{d}/status.json', 'w'), indent=1)
shutil.copy(f'{c}/docs/progress.svg', f'{d}/../public/img/progress.svg')
PY
echo "refreshed data from $C"
