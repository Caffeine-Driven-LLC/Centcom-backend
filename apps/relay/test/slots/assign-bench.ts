/**
 * Times SlotService.assign on Postgres (B031 acceptance 4: p95 under 10 ms).
 * slots.migration.test.ts runs this in a separate Node process, as the audit emitter's
 * emit-bench.ts does: test workers run under coverage instrumentation and share their thread with
 * other test files. Each round fills its own sessions with 50 new members each, as joins do.
 * After a warm-up session, three rounds of 200 assigns; writes `{ p95s }` (milliseconds, one per
 * round) as JSON to stdout.
 *
 * Input, as JSON on stdin: `{ url, sessionIds }`, the migrated database and 1 + 3 x 4 empty
 * sessions in it.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import { closeDb, createDb, createSessionSlotStore, type SessionSlotDatabase } from '@centcom/db';
import { createSlotService, MAX_SESSION_MEMBERS } from '../../src/slots/index.js';

const { url, sessionIds } = JSON.parse(readFileSync(0, 'utf8')) as {
  url: string;
  sessionIds: string[];
};
const ROUNDS = 3;
const SESSIONS_PER_ROUND = 4;

const db = createDb<SessionSlotDatabase>({ url, poolMax: 2 });
const slots = createSlotService(createSessionSlotStore(db));

/** Milliseconds each assign took, filling `sessions` one member at a time. */
async function fill(sessions: string[]): Promise<number[]> {
  const samples: number[] = [];
  for (const session of sessions) {
    for (let i = 0; i < MAX_SESSION_MEMBERS; i++) {
      const member = newId('mem');
      const started = performance.now();
      await slots.assign(session, member);
      samples.push(performance.now() - started);
    }
  }
  return samples;
}

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? Number.POSITIVE_INFINITY;
};

try {
  if (sessionIds.length !== 1 + ROUNDS * SESSIONS_PER_ROUND) {
    throw new Error(`expected ${1 + ROUNDS * SESSIONS_PER_ROUND} sessions`);
  }
  await fill(sessionIds.slice(0, 1));
  const p95s: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const start = 1 + r * SESSIONS_PER_ROUND;
    p95s.push(p95(await fill(sessionIds.slice(start, start + SESSIONS_PER_ROUND))));
  }
  process.stdout.write(JSON.stringify({ p95s }));
} finally {
  await closeDb(db);
}
