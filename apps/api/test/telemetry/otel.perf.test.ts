/**
 * Telemetry overhead (B093 acceptance 7): with tracing at 5 % sampling and exporters pointed at a
 * collector that never answers, the API's p95 latency is at most 5 % above the same app without
 * telemetry, and shutdown flushes within 5 s. Timed in a separate process (otel-bench.ts).
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./otel-bench.ts', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.test.json', import.meta.url));

describe('telemetry overhead', () => {
  it('adds at most 5 % to the API p95, even with the collector down, and shuts down within 5 s', () => {
    const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
      cwd: API_ROOT,
      encoding: 'utf8',
      timeout: 240_000,
    });
    const result = JSON.parse(out) as { ratio: number; ratios: number[]; shutdownMs: number };
    expect(result.ratio, JSON.stringify(result)).toBeLessThanOrEqual(1.05);
    expect(result.shutdownMs).toBeLessThan(5000);
  }, 300_000);
});
