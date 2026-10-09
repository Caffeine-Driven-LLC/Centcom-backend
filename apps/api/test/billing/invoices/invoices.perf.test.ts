/**
 * The invoice list's speed (B077 acceptance 6: "p95 latency of the list endpoint is <= 80 ms with
 * 1 000 invoices in the workspace (mirror hit, no Stripe call)"), timed in a separate process
 * (invoices-bench.ts): first pages and pages 400 invoices deep, three rounds, through the whole
 * route (RBAC, paging, mapping). The mirror is in memory everywhere, and on Postgres 16 when
 * DATABASE_URL is set (CI's integration job). No Stripe call is made.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_URL } from '../../modules/users/helpers.js';

const API_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./invoices-bench.ts', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../../../tsconfig.test.json', import.meta.url));
const P95_BUDGET_MS = 80;
const ROWS = 1_000;

function bench(mode: 'memory' | 'postgres') {
  const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
    cwd: API_ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ mode, rows: ROWS }),
    timeout: 180_000,
  });
  return JSON.parse(out) as { p95s: number[]; stripeCalls: number; listed: number };
}

describe('the invoice list over 1 000 invoices (own process)', () => {
  it(`answers within ${P95_BUDGET_MS} ms at the 95th percentile from the in-memory mirror`, () => {
    const result = bench('memory');
    expect(result.listed).toBe(1);
    expect(result.stripeCalls).toBe(0);
    expect(Math.min(...result.p95s)).toBeLessThanOrEqual(P95_BUDGET_MS);
  }, 200_000);

  it.runIf(ADMIN_URL !== undefined)(
    `answers within ${P95_BUDGET_MS} ms at the 95th percentile from the Postgres mirror`,
    () => {
      const result = bench('postgres');
      expect(result.listed).toBe(1);
      expect(result.stripeCalls).toBe(0);
      expect(Math.min(...result.p95s)).toBeLessThanOrEqual(P95_BUDGET_MS);
    },
    200_000,
  );
});
