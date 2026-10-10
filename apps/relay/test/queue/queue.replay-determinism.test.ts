/**
 * Replay determinism (B052; tests "queue.replay-determinism.test.ts", acceptance 6): order comes
 * only from approve and reorder frames in seq order (two reorders: the later seq wins), and
 * replaying every sequenced frame from seq 1 into a fresh queue rebuilds a byte-identical
 * `queue.state`, as a fast-check property over 200 random frame sequences. A restarted service
 * (an empty cache over the stored rows, or no rows plus the buffered frames) continues the version
 * without a gap.
 */
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createQueueService } from '../../src/queue/service.js';
import { emptyQueue, replay, view } from '../../src/queue/state-machine.js';
import { createMemoryQueueStore } from '../../src/queue/store.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../../src/seq/types.js';
import { queueUnit } from './helpers.js';

const KINDS = [
  'submit',
  'approve',
  'reject',
  'drop',
  'reorder',
  'claim',
  'done',
  'cancel',
] as const;

describe('order', () => {
  it('two reorders: the one with the later seq wins', async () => {
    const u = queueUnit();
    const host = u.member('host');
    const m = u.member('editor');
    const items = [u.submit(), u.submit(), u.submit()];
    for (const f of items) {
      await u.send(m.conn, f);
      await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(f) }));
    }
    const [a, b, c] = items.map((f) => u.itemOf(f)) as [string, string, string];
    const first = await u.send(host.conn, u.op('queue.reorder', { order: [c, a, b] }));
    const second = await u.send(host.conn, u.op('queue.reorder', { order: [b, c, a] }));
    expect((second?.seq ?? 0) > (first?.seq ?? 0)).toBe(true);
    expect(u.stateOf(m.conn)?.items.map((i) => [i.item, i.position])).toEqual([
      [b, 1],
      [c, 2],
      [a, 3],
    ]);
  });

  it('a reorder naming unknown items: applied for the known ones, queue_item_gone once', async () => {
    const u = queueUnit();
    const host = u.member('host');
    const m = u.member('editor');
    const [x, y] = [u.submit(), u.submit()];
    for (const f of [x, y]) {
      await u.send(m.conn, f);
      await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(f) }));
    }
    const stored = await u.send(
      host.conn,
      u.op('queue.reorder', { order: [newId('que'), u.itemOf(y), u.itemOf(x)] }),
    );
    expect(stored).toBeDefined();
    expect(u.errorsOf(host.conn).map((p) => p['code'])).toEqual(['queue_item_gone']);
    expect(u.stateOf(m.conn)?.items.map((i) => i.item)).toEqual([u.itemOf(y), u.itemOf(x)]);
  });
});

describe('replay', () => {
  it('property: replaying every sequenced frame rebuilds a byte-identical queue.state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...KINDS),
            who: fc.nat(2),
            pick: fc.nat(30),
            outcome: fc.constantFrom('ok', 'error', 'canceled'),
            agent: fc.nat(2),
          }),
          { minLength: 5, maxLength: 40 },
        ),
        fc.constantFrom('ask', 'everyone'),
        async (steps, autoApprove) => {
          const u = queueUnit();
          await u.policy({ auto_approve: autoApprove as 'ask' | 'everyone' });
          const host = u.member('host');
          const editors = [u.member('editor'), u.member('editor'), u.member('editor')];
          const agents = [newId('agt'), newId('agt'), newId('agt')];
          const items: string[] = [];
          for (const s of steps) {
            const item =
              items.length === 0 ? newId('que') : (items[s.pick % items.length] as string);
            const editor = editors[s.who] ?? editors[0];
            if (editor === undefined) continue;
            switch (s.kind) {
              case 'submit': {
                const f = u.submit();
                items.push(u.itemOf(f));
                await u.send(editor.conn, f);
                break;
              }
              case 'cancel':
                await u.send(editor.conn, u.op('queue.cancel', { item }));
                break;
              case 'reorder': {
                const order = [...items].reverse().slice(0, (s.pick % 5) + 1);
                await u.send(host.conn, u.op('queue.reorder', { order }));
                break;
              }
              case 'claim':
                await u.send(host.conn, u.op('queue.claim', { item, agent_id: agents[s.agent] }));
                break;
              case 'done':
                await u.send(host.conn, u.op('queue.done', { item, outcome: s.outcome }));
                break;
              case 'reject':
                await u.send(host.conn, u.op('queue.reject', { item, code: 'other' }));
                break;
              default:
                await u.send(host.conn, u.op(`queue.${s.kind}`, { item }));
            }
          }
          const frames = await u.sequenced();
          const live = u.service.snapshot(u.sid);
          const rebuilt = view(replay(emptyQueue(), frames));
          expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(live));
          const lastState = frames.filter((f) => f.k === 'queue.state').at(-1);
          if (lastState !== undefined) {
            expect(JSON.stringify((lastState as { p: unknown }).p)).toBe(JSON.stringify(live));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  for (const from of ['the stored rows', 'the buffered frames alone'] as const) {
    it(`a restarted service continues from ${from} without a version gap`, async () => {
      const u = queueUnit();
      const host = u.member('host');
      const m = u.member('editor');
      const f = u.submit();
      await u.send(m.conn, f);
      await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(f) }));
      const before = u.service.snapshot(u.sid);
      const restarted = createQueueService({
        store: from === 'the stored rows' ? u.queueStore : createMemoryQueueStore(),
        policies: u.policies,
        sequencer: {
          emitState: (sid, body) => u.fanout.emitServer(sid, 'queue.state', 'queue', { ...body }),
          framesAfter: (sid, after) => u.store.range(sid, after, 1_000),
          resend: () => Promise.resolve(false),
        },
      });
      const frame = u.op('queue.drop', { item: u.itemOf(f) });
      const fc = { connection: host.conn, raw: '', frame, state: {} as Record<string, unknown> };
      const outcome = await restarted.handle(
        {
          sid: u.sid,
          sender: { id: host.mid, role: 'host', userId: host.userId, workspaceId: u.wsp },
          connection: host.conn,
          async sequence() {
            await u.sequencer.stage(fc, () => u.fanout.stage(fc, () => Promise.resolve()));
            const stored = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
            return stored === undefined ? undefined : { frame: stored, companions: [] };
          },
        },
        { t: 'queue', id: frame.id, k: 'queue.drop', p: frame.p },
      );
      expect(outcome.accepted).toBe(true);
      expect(restarted.snapshot(u.sid).version).toBe(before.version + 1);
      expect(restarted.snapshot(u.sid).items).toEqual([]);
    });
  }
});
