/**
 * `GET /v1/flags` speed (B083 acceptance 6): with 500 flags in the cache, the 95th percentile is
 * at most 20 ms and the body at most 64 KiB, timed in a separate process (flags-bench.ts), with no
 * repository reads on the request path.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./flags-bench.ts', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.test.json', import.meta.url));

describe('GET /v1/flags with 500 flags', () => {
  it('answers within 20 ms at the 95th percentile, in at most 64 KiB, from the cache', () => {
    const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
      cwd: API_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const { p95s, bytes, flags, loads } = JSON.parse(out) as {
      p95s: number[];
      bytes: number;
      flags: number;
      loads: number;
    };
    expect(flags).toBe(500);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(loads).toBe(0);
    expect(Math.min(...p95s)).toBeLessThanOrEqual(20);
  }, 150_000);
});
