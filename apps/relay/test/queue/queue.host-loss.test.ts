/**
 * Host loss (B052; tests "queue.host-loss.test.ts", acceptance 8): the host's last connection
 * closing marks approved and running items `held` in a new `queue.state` within 1 s; the host
 * coming back restores them; after `control.host_changed` (B051's hook) the held items show as
 * approved again. A frame from the host also ends the absence.
 */
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { queueUnit } from './helpers.js';

async function setup() {
  const u = queueUnit();
  const host = u.member('host');
  const m = u.member('editor');
  const [a, b, c] = [u.submit(), u.submit(), u.submit()];
  for (const f of [a, b, c]) await u.send(m.conn, f);
  await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(a) }));
  await u.send(host.conn, u.op('queue.approve', { item: u.itemOf(b) }));
  await u.send(host.conn, u.op('queue.claim', { item: u.itemOf(b), agent_id: newId('agt') }));
  return { u, host, m, items: [a, b, c].map((f) => u.itemOf(f)) };
}

const statesOf = (body: { items: { item: string; state: string }[] } | undefined) =>
  Object.fromEntries((body?.items ?? []).map((i) => [i.item, i.state]));

describe('host loss', () => {
  it('holds approved and running items within 1 s, and restores them when the host is back', async () => {
    const { u, host, m, items } = await setup();
    const [a, b, c] = items as [string, string, string];
    const started = performance.now();
    host.conn.close(1001 as never);
    await u.settle();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(statesOf(u.stateOf(m.conn))).toEqual({ [a]: 'held', [b]: 'held', [c]: 'queued' });
    const heldVersion = u.stateOf(m.conn)?.version ?? 0;

    u.member('host', { mid: host.mid });
    await u.settle();
    expect(statesOf(u.stateOf(m.conn))).toEqual({ [a]: 'approved', [b]: 'running', [c]: 'queued' });
    expect(u.stateOf(m.conn)?.version).toBe(heldVersion + 1);
  });

  it('after control.host_changed the held items show as approved', async () => {
    const { u, host, m, items } = await setup();
    const [a] = items as [string];
    host.conn.close(1001 as never);
    await u.settle();
    expect(statesOf(u.stateOf(m.conn))[a]).toBe('held');
    // B051 transferred (or B053 failed over) to a connected editor.
    await u.service.onHostChanged(u.sid);
    expect(statesOf(u.stateOf(m.conn))[a]).toBe('approved');
  });

  it('an item auto-approved while the host is away is held', async () => {
    const { u, host, m } = await setup();
    await u.policy({ auto_approve: 'everyone' });
    host.conn.close(1001 as never);
    await u.settle();
    const f = u.submit();
    await u.send(m.conn, f);
    expect(statesOf(u.stateOf(m.conn))[u.itemOf(f)]).toBe('held');
  });

  it('a frame from the host ends the absence first', async () => {
    const { u, host, m, items } = await setup();
    const [a, , c] = items as [string, string, string];
    host.conn.close(1001 as never);
    await u.settle();
    // The host's state on this node says away; a frame from another device of the host arrives.
    const again = u.member('host', { mid: host.mid, connected: true });
    await u.settle();
    await u.send(again.conn, u.op('queue.approve', { item: c }));
    expect(statesOf(u.stateOf(m.conn))).toMatchObject({ [a]: 'approved', [c]: 'approved' });
  });

  it('a non-host leaving changes nothing', async () => {
    const { u, m } = await setup();
    const version = u.service.snapshot(u.sid).version;
    const other = u.member('editor');
    other.conn.close(1001 as never);
    await u.settle();
    expect(u.service.snapshot(u.sid).version).toBe(version);
    expect(m.conn.closedWith).toBeNull();
  });
});
