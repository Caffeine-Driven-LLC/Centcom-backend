/**
 * Times AuditEmitter.emit on Postgres (B036 acceptance 6: p95 under 5 ms). audit.emit.test.ts runs
 * this in a separate Node process, as redact-bench.ts does: test workers run under coverage
 * instrumentation, which slows this code several times over, and share their thread with other
 * test files. Each emit runs in a transaction of its own and only the emit is timed. After a
 * warm-up, three rounds of 300; writes `{ p95s }` (milliseconds, one per round) as JSON to stdout.
 *
 * Input, as JSON on stdin: `{ url, workspaceId, userId }`, the migrated database and a workspace
 * and user in it.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createAuditEmitter, type AuditEvent } from '@centcom/core';
import { closeDb, createDb, withTransaction, type CoreDatabase } from '../../src/index.js';

const { url, workspaceId, userId } = JSON.parse(readFileSync(0, 'utf8')) as {
  url: string;
  workspaceId: string;
  userId: string;
};
const WARM_UP = 50;
const ROUNDS = 3;
const PER_ROUND = 300;

const event: AuditEvent = {
  workspaceId,
  actor: { type: 'user', id: userId },
  action: 'member.role_change',
  target: { type: 'workspace', id: workspaceId },
  outcome: 'success',
  meta: { user_id: userId, from_role: 'member', to_role: 'admin' },
};

const db = createDb<CoreDatabase>({ url, poolMax: 2 });
const emitter = createAuditEmitter({ db });

/** Milliseconds each of `n` emits took. */
async function round(n: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    await withTransaction(db, async (trx) => {
      const started = performance.now();
      await emitter.emit(trx, event);
      samples.push(performance.now() - started);
    });
  }
  return samples;
}

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? Number.POSITIVE_INFINITY;
};

try {
  await round(WARM_UP);
  const p95s: number[] = [];
  for (let r = 0; r < ROUNDS; r++) p95s.push(p95(await round(PER_ROUND)));
  process.stdout.write(JSON.stringify({ p95s }));
} finally {
  await closeDb(db);
}
