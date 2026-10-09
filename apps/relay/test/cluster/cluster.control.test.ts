/**
 * Member control across nodes (B045; tests "cluster.control.test.ts", acceptance 3 and 4,
 * guardrail "control commands only from server code"):
 *
 * - a `(member, device)` connecting to node B closes its connection on node A with `sys.bye
 *   superseded` and 4409 within 500 ms; another device of the member stays;
 * - `memberControl.closeMember(mid, {code: 4403})` (a removed membership, B051's kick) closes the
 *   member's connections on every node, the caller's included, with `sys.error not_a_member`,
 *   within 1 s;
 * - a command names only the device and the connections older than it asks; a malformed command
 *   is refused, and a malformed or own-node control message changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { controlChannel } from '../../src/cluster/channels.js';
import { until } from '../helpers.js';
import { cluster } from './helpers.js';

const twoOrMore = <T>(xs: T[]): [T, T, ...T[]] => xs as [T, T, ...T[]];

describe('supersede across nodes (acceptance 3)', () => {
  it('closes the device’s connection on the other node with 4409 within 500 ms', async () => {
    const c = await cluster(2);
    try {
      const [a, b] = twoOrMore(c.nodes);
      const me = c.member();
      const onA = await c.client(a, me);
      const otherDevice = await c.client(a, c.device(me));
      const started = Date.now();
      const onB = await c.client(b, me);
      await until(() => onA.closeInfo !== undefined, 2_000);
      expect(Date.now() - started).toBeLessThan(500);
      expect(onA.closeInfo?.code).toBe(4409);
      expect(onA.wire.at(-1)).toMatchObject({ t: 'sys.bye', p: { reason: 'superseded' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onB.isOpen).toBe(true);
      expect(otherDevice.isOpen).toBe(true);
    } finally {
      await c.stop();
    }
  }, 20_000);
});

describe('closing a member everywhere (acceptance 4)', () => {
  it('closes the member on every node within 1 s; others stay', async () => {
    const c = await cluster(3);
    try {
      const [a, b, third] = c.nodes as [
        (typeof c.nodes)[0],
        (typeof c.nodes)[0],
        (typeof c.nodes)[0],
      ];
      const removed = c.member();
      const onA = await c.client(a, removed);
      const onB = await c.client(b, c.device(removed));
      const onC = await c.client(third, c.device(removed));
      const bystander = await c.client(a);
      const started = Date.now();
      await third.cluster().memberControl.closeMember(removed.mid, { code: 4403 });
      await until(() => [onA, onB, onC].every((x) => x.closeInfo !== undefined), 2_000);
      expect(Date.now() - started).toBeLessThan(1_000);
      for (const x of [onA, onB, onC]) {
        expect(x.closeInfo?.code).toBe(4403);
        expect(x.wire.find((f) => f.t === 'sys.error')?.p).toMatchObject({ code: 'not_a_member' });
      }
      expect(bystander.isOpen).toBe(true);
    } finally {
      await c.stop();
    }
  }, 20_000);

  it('keeps connections opened after the command (before) and of other devices', async () => {
    const c = await cluster(2);
    try {
      const [a, b] = twoOrMore(c.nodes);
      const me = c.member();
      const old = await c.client(a, me);
      const cut = Date.now() + 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const newer = await c.client(a, c.device(me));
      await b.cluster().memberControl.closeMember(me.mid, { code: 4403, before: cut });
      await until(() => old.closeInfo !== undefined, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(newer.isOpen).toBe(true);
    } finally {
      await c.stop();
    }
  }, 20_000);
});

describe('commands come from server code only', () => {
  it('refuses a malformed command; ignores malformed and own-node messages', async () => {
    const c = await cluster(2);
    try {
      const [a, b] = twoOrMore(c.nodes);
      const me = c.member();
      const onA = await c.client(a, me);
      const control = b.cluster().memberControl;
      for (const bad of [
        { code: 1234 },
        { code: 4409, bye: 'Not A Reason!' },
        { code: 4403, device: 'phone' },
        { code: 4403, error: 'session_ended' as const },
      ]) {
        await expect(control.closeMember(me.mid, bad)).rejects.toThrow(TypeError);
      }
      const count = (result: string) =>
        a.metrics.count('relay_cluster_received_total', { channel: 'ctl', result });
      const before = { invalid: count('invalid'), own: count('own') };
      for (const message of [
        'not json',
        JSON.stringify({ node: 'node-b', mid: me.mid, cmd: { code: 99 } }),
        JSON.stringify({ node: 'node-a', mid: me.mid, cmd: { code: 4403 } }),
        JSON.stringify({ node: 'node-b', mid: 'mem_other', cmd: { code: 4403 } }),
      ]) {
        await c.shared.pubsub.publish(controlChannel(me.mid), message);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onA.isOpen).toBe(true);
      expect(count('invalid') - before.invalid).toBe(3);
      expect(count('own') - before.own).toBe(1);
    } finally {
      await c.stop();
    }
  }, 20_000);

  it('a client frame cannot reach the control channel', async () => {
    const c = await cluster(2);
    try {
      const [a, b] = twoOrMore(c.nodes);
      const me = c.member();
      const onA = await c.client(a, me);
      const onB = await c.client(b);
      // Whatever a client sends, nothing on this node publishes a command for it.
      onB.sendRaw(JSON.stringify({ v: 1, t: 'sys.bye', p: { reason: 'superseded' } }));
      onB.sendRaw(JSON.stringify({ node: 'node-b', mid: me.mid, cmd: { code: 4403 } }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(onA.isOpen).toBe(true);
      // Only its own welcome's supersede was published.
      expect(b.metrics.count('relay_cluster_published_total', { channel: 'ctl' })).toBe(1);
    } finally {
      await c.stop();
    }
  }, 20_000);
});
