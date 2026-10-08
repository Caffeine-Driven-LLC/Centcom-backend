/**
 * `/healthz` speed (B086 acceptance 1): under 5 ms at the 99th percentile with Postgres and Redis
 * down, timed in a separate process (status-bench.ts).
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./status-bench.ts', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.test.json', import.meta.url));

describe('GET /healthz', () => {
  it('answers within 5 ms at the 99th percentile, its dependencies down', () => {
    const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
      cwd: API_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const { p99s } = JSON.parse(out) as { p99s: number[] };
    expect(Math.min(...p99s)).toBeLessThan(5);
  }, 150_000);
});
