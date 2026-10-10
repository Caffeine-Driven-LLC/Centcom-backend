/**
 * The queue fixtures (B052; tests "queue.contract.test.ts"): every client queue fixture in
 * `contracts/fixtures/events/queue.*.json` decodes (B039) and, with its ids pointed at real items,
 * is accepted; every frame the relay sequences for it (the frame, the relay's `queue.approve`, and
 * `queue.state` with QueueItemView items) validates against the generated envelope and payload
 * schemas.
 */
import { validateEnvelope, validateEvent, type EventKind } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../../src/codec/codec.js';
import { fixture } from '../control/helpers.js';
import { queueUnit } from './helpers.js';

const CLIENT_KINDS = [
  'queue.submit',
  'queue.approve',
  'queue.reorder',
  'queue.claim',
  'queue.done',
  'queue.reject',
  'queue.drop',
  'queue.cancel',
] as const;

describe('queue fixtures', () => {
  for (const kind of CLIENT_KINDS) {
    it(`${kind}: decodes, is accepted, and what the relay sequences validates`, async () => {
      const u = queueUnit();
      await u.policy({ auto_approve: 'everyone' });
      const host = u.member('host');
      const m = u.member('editor');
      const frame = fixture(kind);
      expect(decodeFrame(JSON.stringify(frame), false, String(frame['sid'])).ok).toBe(true);
      // An item to act on: submitted (auto-approved), and claimed for queue.done.
      const sub = u.submit();
      await u.send(m.conn, sub);
      const item = u.itemOf(sub);
      if (kind === 'queue.done') {
        await u.send(
          host.conn,
          u.op('queue.claim', { item, agent_id: 'agt_01JA3Z8K2M5N7P9Q0R1S2T3V4W' }),
        );
      }
      if (kind === 'queue.approve' || kind === 'queue.reject') {
        await u.policy({ auto_approve: 'ask' });
        const second = u.submit();
        await u.send(m.conn, second);
        Object.assign(sub.p, { item: u.itemOf(second) });
      }
      const p = { ...(frame['p'] as Record<string, unknown>) };
      if ('item' in p) p['item'] = u.itemOf(sub);
      if ('order' in p) p['order'] = [item];
      const sender = kind === 'queue.submit' || kind === 'queue.cancel' ? m : host;
      const stored =
        kind === 'queue.submit'
          ? await u.send(m.conn, {
              ...frame,
              sid: u.sid,
              from: undefined,
              seq: undefined,
              ts: undefined,
              id: u.submit().id,
            })
          : await u.send(sender.conn, u.op(kind, p));
      expect(u.errorsOf(sender.conn)).toEqual([]);
      expect(stored).toBeDefined();
      for (const f of await u.sequenced()) {
        expect(validateEnvelope(f)).toMatchObject({ ok: true });
        expect(validateEvent(f.k as EventKind, (f as { p?: unknown }).p)).toMatchObject({
          ok: true,
        });
      }
    });
  }

  it('queue.state carries QueueItemView items', async () => {
    const u = queueUnit();
    const m = u.member('editor');
    await u.send(m.conn, u.submit());
    const [item] = u.stateOf(m.conn)?.items ?? [];
    expect(Object.keys(item ?? {}).sort()).toEqual(
      ['item', 'kind', 'position', 'size', 'state', 'submitter', 'ts'].sort(),
    );
  });
});
