/**
 * The queue store on Postgres 16 (B052; B010's test stack), with migration
 * 20260102004000_queue_items.sql applied: a round trip of a session's queue (version, host flag,
 * order as positions, held items, agents), conditional upserts, the session lock serialising two
 * writers, a rollback discarding a save, the checks (size over 192 KiB refused), and the purge
 * cascade.
 */
import { newId } from '@centcom/contracts';
import { createFactories } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RelayDb } from '../../src/modules.js';
import {
  emptyQueue,
  reduce,
  type QueueModel,
  type QueueOp,
} from '../../src/queue/state-machine.js';
import { createPostgresQueueStore, type QueueDb } from '../../src/queue/store.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';

const TS = '2026-10-10T00:00:00.000Z';

/** `ops` applied in order from an empty queue; the model and every changed id. */
function build(ops: QueueOp[]): { model: QueueModel; changed: string[] } {
  let model = emptyQueue();
  const changed: string[] = [];
  ops.forEach((op, i) => {
    const r = reduce(model, op, i + 1, TS);
    if (!r.ok) throw new Error(r.refusal);
    model = r.model;
    changed.push(...r.changed);
  });
  return { model, changed };
}

describe.runIf(STACK)('the queue on Postgres 16', () => {
  let stack: TestStack;
  let db: QueueDb;
  let f: ReturnType<typeof createFactories>;

  beforeAll(async () => {
    stack = await startTestStack();
    db = stack.db as unknown as QueueDb;
    f = createFactories(stack.db);
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  const session = async () => {
    const workspace = await f.workspaces.create();
    return f.sessions.create({ workspace: workspace.id, state: 'live' });
  };

  it('round-trips a queue: version, host flag, order, held and running items', async () => {
    const s = await session();
    const store = createPostgresQueueStore(db);
    const [a, b, c] = [newId('que'), newId('que'), newId('que')];
    const from = newId('mem');
    const agent = newId('agt');
    const { model, changed } = build([
      { k: 'queue.submit', from, item: a, size: 3, kind: 'message' },
      { k: 'queue.submit', from, item: b, size: 196_608, kind: 'command' },
      { k: 'queue.submit', from, item: c, size: 0, kind: 'message' },
      { k: 'queue.approve', item: a },
      { k: 'queue.approve', item: b },
      { k: 'queue.reorder', order: [b, a] },
      { k: 'queue.claim', item: a, agentId: agent },
      { k: 'host', away: true },
    ]);
    expect(await store.withSession(s.id, (tx) => tx.load())).toBeNull();
    await store.withSession(s.id, (tx) => tx.save(model, changed, 8));
    const loaded = await store.withSession(s.id, (tx) => tx.load());
    expect(loaded).toMatchObject({ version: 8, hostAway: true, updatedSeq: 8, order: [b] });
    const byId = new Map(loaded?.items.map((i) => [i.item, i]));
    expect(byId.get(a)).toMatchObject({ state: 'held', heldFrom: 'running', agentId: agent });
    expect(byId.get(b)).toMatchObject({ state: 'held', heldFrom: 'approved', size: 196_608 });
    expect(byId.get(c)).toMatchObject({ state: 'queued', ts: TS, createdSeq: 3 });
  });

  it('discards a save when the callback throws', async () => {
    const s = await session();
    const store = createPostgresQueueStore(db);
    const { model, changed } = build([
      { k: 'queue.submit', from: newId('mem'), item: newId('que'), size: 1, kind: 'message' },
    ]);
    await expect(
      store.withSession(s.id, async (tx) => {
        await tx.save(model, changed, 1);
        throw new Error('not sequenced');
      }),
    ).rejects.toThrow('not sequenced');
    expect(await store.withSession(s.id, (tx) => tx.load())).toBeNull();
  });

  it('serialises two writers on one session', async () => {
    const s = await session();
    const store = createPostgresQueueStore(db);
    const order: string[] = [];
    const slow = store.withSession(s.id, async (tx) => {
      order.push('a:start');
      await tx.load();
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push('a:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = store.withSession(s.id, async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('refuses an item over 192 KiB (the table’s check)', async () => {
    const s = await session();
    const store = createPostgresQueueStore(db);
    const { model, changed } = build([
      { k: 'queue.submit', from: newId('mem'), item: newId('que'), size: 196_609, kind: 'message' },
    ]);
    await expect(store.withSession(s.id, (tx) => tx.save(model, changed, 1))).rejects.toThrow();
  });

  it('goes with its session', async () => {
    const s = await session();
    const store = createPostgresQueueStore(db);
    const { model, changed } = build([
      { k: 'queue.submit', from: newId('mem'), item: newId('que'), size: 1, kind: 'message' },
    ]);
    await store.withSession(s.id, (tx) => tx.save(model, changed, 1));
    await (stack.db as unknown as RelayDb).deleteFrom('sessions').where('id', '=', s.id).execute();
    const rows = await db
      .selectFrom('queue_item')
      .select('item_id')
      .where('session_id', '=', s.id)
      .execute();
    expect(rows).toEqual([]);
  });
});
