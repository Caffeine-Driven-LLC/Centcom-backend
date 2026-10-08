/**
 * Detached audit events (B036, card test audit.detached.test.ts, acceptance 4 and 5, on a fake
 * clock): emitDetached never throws; batches of up to 100 are written every 250 ms; at most 1 000
 * events wait, and a full queue drops its oldest, counted in `audit_events_dropped_total` and
 * logged; a database that is down is retried with backoff and jitter while the events wait; rows
 * the database refuses are dropped alone; and flush writes everything queued, or reports what it
 * could not by its deadline. On Postgres: packages/db/test/audit/audit.detached.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_BATCH_INTERVAL_MS,
  AUDIT_BATCH_MAX,
  AUDIT_QUEUE_MAX,
  createAuditEmitter,
  type AuditEvent,
  type Logger,
  type Metrics,
} from '../../src/index.js';
import {
  captureLogger,
  deferred,
  fakeDb,
  pgError,
  recordingMetrics,
  rowsOf,
  sampleEvent,
} from './helpers.js';
import { newId } from '@centcom/contracts';

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
/** What `pg` throws when the server is gone. */
const connectionLost = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(): {
  db: ReturnType<typeof fakeDb>;
  log: ReturnType<typeof captureLogger>;
  emitter: ReturnType<typeof createAuditEmitter>;
  count: ReturnType<typeof recordingMetrics>['count'];
  observations: ReturnType<typeof recordingMetrics>['observations'];
} {
  const db = fakeDb();
  const log = captureLogger();
  const recorded = recordingMetrics();
  const emitter = createAuditEmitter({ db, logger: log.logger, metrics: recorded.metrics });
  return { db, log, emitter, count: recorded.count, observations: recorded.observations };
}

/** `n` events numbered from `from` (in `meta.from_seats`), to follow their order. */
const numbered = (n: number, from = 0): AuditEvent[] =>
  Array.from({ length: n }, (_, i) =>
    sampleEvent({ action: 'billing.seats', target: undefined, meta: { from_seats: from + i } }),
  );
const numbers = (rows: Record<string, unknown>[]): number[] =>
  rows.map((r) => (JSON.parse(String(r['meta'])) as { from_seats: number }).from_seats);
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);
const lines = (log: ReturnType<typeof captureLogger>, msg: string): Record<string, unknown>[] =>
  log.lines().filter((l) => l['msg'] === msg);

describe('emitDetached', () => {
  it('writes batches of up to 100, one every 250 ms, then goes quiet', async () => {
    const { db, emitter, count } = setup();
    for (const event of numbered(250)) emitter.emitDetached(event);
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS - 1);
    expect(db.queries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.rows).toHaveLength(100);
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS);
    expect(db.rows).toHaveLength(200);
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS);
    expect(db.queries.map((q) => rowsOf(q).length)).toEqual([AUDIT_BATCH_MAX, AUDIT_BATCH_MAX, 50]);
    expect(numbers(db.rows)).toEqual(range(0, 250));
    // A retried batch may have landed the first time: it must not write its rows twice.
    for (const q of db.queries) expect(q.sql).toMatch(/ on conflict \("id"\) do nothing$/);
    expect(count('audit_events_written_total', { mode: 'detached' })).toBe(250);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.queries).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stamps an event when it is emitted, not when its batch is written', async () => {
    const { db, emitter } = setup();
    emitter.emitDetached(sampleEvent());
    await vi.advanceTimersByTimeAsync(100);
    emitter.emitDetached(sampleEvent());
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS);
    expect(db.queries).toHaveLength(1);
    expect(db.rows.map((r) => r['created_at'])).toEqual([new Date(T0), new Date(T0 + 100)]);
  });

  it('keeps at most 1 000 events: a full queue drops its oldest, counted and logged', async () => {
    const { db, log, emitter, count } = setup();
    const gate = deferred();
    db.gate = gate.promise;
    for (const event of numbered(AUDIT_QUEUE_MAX)) emitter.emitDetached(event);
    expect(count('audit_events_dropped_total', { reason: 'overflow' })).toBe(0);
    // The first batch (events 0-99) is now being written and stalls; it still counts.
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS);
    for (const event of numbered(150, AUDIT_QUEUE_MAX)) emitter.emitDetached(event);
    expect(count('audit_events_dropped_total', { reason: 'overflow' })).toBe(150);
    db.gate = undefined;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(20 * AUDIT_BATCH_INTERVAL_MS);
    // The oldest waiting events (100-249) were dropped; the batch in flight was not.
    expect(numbers(db.rows)).toEqual([...range(0, 100), ...range(250, 1150)]);
    const dropped = lines(log, 'audit.dropped');
    expect(dropped.every((l) => l['reason'] === 'overflow' && l['level'] === 'error')).toBe(true);
    expect(dropped.reduce((sum, l) => sum + Number(l['dropped']), 0)).toBe(150);
    // The first loss is logged at once, the rest in one line when the queue has drained.
    expect(dropped).toHaveLength(2);
  });

  it('retries a database that is down with exponential backoff, keeping the events', async () => {
    const { db, log, emitter, count } = setup();
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const attempts: number[] = [];
    db.failWith = () => {
      attempts.push(Date.now() - T0);
      return connectionLost();
    };
    for (const event of numbered(10)) emitter.emitDetached(event);
    await vi.advanceTimersByTimeAsync(26_000);
    // 250 ms, then pauses of 500 ms doubling up to the 10 s cap.
    expect(attempts).toEqual([250, 750, 1750, 3750, 7750, 15_750, 25_750]);
    expect(
      lines(log, 'audit.write_failed').map((l) => [l['error_code'], l['attempt'], l['pending']]),
    ).toEqual(range(1, 8).map((attempt) => ['ECONNREFUSED', attempt, 10]));
    db.failWith = undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(numbers(db.rows)).toEqual(range(0, 10));
    expect(count('audit_events_dropped_total', { reason: 'overflow' })).toBe(0);
    // Back to the normal pace after a success.
    emitter.emitDetached(sampleEvent());
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS);
    expect(db.rows).toHaveLength(11);
  });

  it('jitters its retries between half and all of the backoff', async () => {
    const { db, emitter } = setup();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const attempts: number[] = [];
    db.failWith = () => {
      attempts.push(Date.now() - T0);
      return connectionLost();
    };
    emitter.emitDetached(sampleEvent());
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toEqual([250, 500, 1000, 2000]);
  });

  it('drops only the rows the database refuses, once, and writes the others', async () => {
    const { db, log, emitter, count } = setup();
    const gone = newId('wsp');
    db.failWith = (rows) =>
      rows.some((r) => r['workspace_id'] === gone) ? pgError('23503', 'foreign key') : undefined;
    const events = numbered(5);
    events[2] = { ...events[2], workspaceId: gone } as AuditEvent;
    for (const event of events) emitter.emitDetached(event);
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS);
    expect(numbers(db.rows)).toEqual([0, 1, 3, 4]);
    expect(count('audit_events_dropped_total', { reason: 'rejected' })).toBe(1);
    expect(lines(log, 'audit.dropped')).toEqual([
      expect.objectContaining({
        reason: 'rejected',
        dropped: 1,
        action: 'billing.seats',
        error_code: '23503',
      }),
    ]);
    // The batch, then each row alone; nothing is retried afterwards.
    expect(db.queries.map((q) => rowsOf(q).length)).toEqual([5, 1, 1, 1, 1, 1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.queries).toHaveLength(6);
  });

  it('puts the rest back when the database goes down while it writes row by row', async () => {
    const { db, emitter, count } = setup();
    let calls = 0;
    db.failWith = () => {
      calls += 1;
      if (calls === 1) return pgError('23514', 'check');
      if (calls === 3) return connectionLost();
      return undefined;
    };
    for (const event of numbered(5)) emitter.emitDetached(event);
    await vi.advanceTimersByTimeAsync(5000);
    expect(numbers(db.rows)).toEqual(range(0, 5));
    expect(count('audit_events_written_total', { mode: 'detached' })).toBe(5);
    expect(count('audit_events_dropped_total', { reason: 'rejected' })).toBe(0);
  });

  it('never throws: refused events are counted and logged instead', () => {
    const { log, emitter, count } = setup();
    const refused = [
      null,
      'member.add',
      { ...sampleEvent(), action: 'member.promote' },
      { ...sampleEvent(), action: 'ada@example.com' },
      sampleEvent({ workspaceId: 'acme' }),
      sampleEvent({ meta: { to_role: 'x'.repeat(500) } }),
      sampleEvent({ actor: undefined as never }),
    ];
    for (const event of refused) {
      expect(() => emitter.emitDetached(event as AuditEvent)).not.toThrow();
    }
    expect(count('audit_events_dropped_total', { reason: 'invalid' })).toBe(refused.length);
    const dropped = lines(log, 'audit.dropped');
    expect(dropped).toHaveLength(refused.length);
    expect(dropped.every((l) => l['reason'] === 'invalid')).toBe(true);
    // A known action is named; an unknown one is not echoed.
    expect(dropped.map((l) => l['action'])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'member.role_change',
      'member.role_change',
      'member.role_change',
    ]);
    expect(log.raw()).not.toContain('ada@example.com');
  });

  it('never throws when its logger and metrics do', async () => {
    const boom = (): never => {
      throw new Error('down');
    };
    const metrics: Metrics = {
      counter: () => ({ inc: boom }),
      histogram: () => ({ observe: boom }),
    };
    const logger = { error: boom, warn: boom, info: boom } as unknown as Logger;
    const db = fakeDb();
    const emitter = createAuditEmitter({ db, logger, metrics });
    expect(() => emitter.emitDetached(null as never)).not.toThrow();
    for (const event of numbered(AUDIT_QUEUE_MAX + 5)) {
      expect(() => emitter.emitDetached(event)).not.toThrow();
    }
    await emitter.flush(5000);
    // A batch whose bookkeeping threw is written again; `on conflict do nothing` keeps one copy.
    expect(new Set(db.rows.map((r) => r['id'])).size).toBe(AUDIT_QUEUE_MAX);
  });

  it('refuses a transaction as its pool', () => {
    expect(() => createAuditEmitter({ db: fakeDb(true) })).toThrow(TypeError);
  });

  it('times its batches', async () => {
    const { emitter, observations } = setup();
    for (const event of numbered(3)) emitter.emitDetached(event);
    await vi.advanceTimersByTimeAsync(AUDIT_BATCH_INTERVAL_MS);
    expect(observations).toEqual([
      expect.objectContaining({ name: 'audit_emit_latency_ms', labels: { mode: 'detached' } }),
    ]);
  });
});

describe('flush', () => {
  it('writes everything queued at once, in batches of 100, without waiting for the timer', async () => {
    const { db, emitter } = setup();
    for (const event of numbered(AUDIT_QUEUE_MAX)) emitter.emitDetached(event);
    await emitter.flush(5000);
    expect(numbers(db.rows)).toEqual(range(0, AUDIT_QUEUE_MAX));
    expect(db.queries.map((q) => rowsOf(q).length)).toEqual(Array<number>(10).fill(100));
    expect(Date.now()).toBe(T0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(emitter.flush(5000)).resolves.toBeUndefined();
  });

  it('retries until its deadline, logs what it could not write, and leaves it queued', async () => {
    const { db, log, emitter } = setup();
    db.failWith = connectionLost;
    for (const event of numbered(10)) emitter.emitDetached(event);
    const flushed = emitter.flush(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(flushed).resolves.toBeUndefined();
    expect(lines(log, 'audit.flush_incomplete')).toEqual([
      expect.objectContaining({ level: 'error', pending: 10 }),
    ]);
    expect(db.queries.length).toBeGreaterThan(3);
    db.failWith = undefined;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(numbers(db.rows)).toEqual(range(0, 10));
  });

  it('returns at its deadline even when a write hangs', async () => {
    const { db, log, emitter } = setup();
    const gate = deferred();
    db.gate = gate.promise;
    for (const event of numbered(3)) emitter.emitDetached(event);
    const flushed = emitter.flush(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(flushed).resolves.toBeUndefined();
    expect(lines(log, 'audit.flush_incomplete')).toEqual([expect.objectContaining({ pending: 3 })]);
    db.gate = undefined;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(db.rows).toHaveLength(3);
  });
});
