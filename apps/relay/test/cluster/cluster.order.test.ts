/**
 * Order across nodes (B045; tests "cluster.order.test.ts", acceptance 1 and 6, guardrail "pub/sub
 * is lossy and unordered"): with members on three nodes of one session and pub/sub delivery
 * delayed at random by up to 50 ms per message, 1 000 frames sent from every node reach every
 * client in the same total `seq` order, once each, over 3 runs. At the dispatcher, a fast-check
 * property: whatever order, duplicates, own-node echoes and losses the messages come in, a local
 * connection gets 1..n exactly once and in order (losses filled from the hot buffer).
 */
import { newId } from '@centcom/contracts';
import type { SimClient } from '@centcom/testkit/sim';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ClusterDispatcher } from '../../src/cluster/dispatcher.js';
import { createFanOut } from '../../src/fanout/fanout.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import type { StoredFrame } from '../../src/seq/types.js';
import { manualTimers, textConnection } from '../fanout/helpers.js';
import { until } from '../helpers.js';
import { LIMITS, reaction } from '../seq/helpers.js';
import { cluster, range, seqs } from './helpers.js';

describe('three nodes, random pub/sub delays (acceptance 1)', () => {
  for (let run = 1; run <= 3; run += 1) {
    it(`run ${run}: every client gets 1..1000 once, in order`, async () => {
      const c = await cluster(3);
      try {
        for (const node of c.nodes) node.redis.delayMs = () => Math.random() * 50;
        const clients: SimClient[] = [];
        for (const node of c.nodes) {
          clients.push(await c.client(node), await c.client(node));
        }
        await Promise.all(
          Array.from({ length: 1_000 }, (_, i) =>
            clients[i % clients.length]?.send('reaction', reaction()),
          ),
        );
        await until(() => clients.every((cl) => seqs(cl).length >= 1_000), 20_000);
        for (const cl of clients) expect(seqs(cl)).toEqual(range(1, 1_000));
      } finally {
        await c.stop();
      }
    }, 40_000);
  }
});

describe('own-node filter (acceptance 6)', () => {
  it('five nodes: each client gets each frame exactly once', async () => {
    const c = await cluster(5);
    try {
      const clients = await Promise.all(c.nodes.map((node) => c.client(node)));
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          clients[i % clients.length]?.send('reaction', reaction()),
        ),
      );
      await until(() => clients.every((cl) => seqs(cl).length >= 100), 10_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const cl of clients) expect(seqs(cl)).toEqual(range(1, 100));
      for (const node of c.nodes) {
        expect(
          node.metrics.count('relay_cluster_received_total', { channel: 'frames', result: 'own' }),
        ).toBeGreaterThan(0);
      }
    } finally {
      await c.stop();
    }
  }, 30_000);
});

describe('the dispatcher under any delivery (property)', () => {
  it('releases 1..n exactly once and in order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 80 }),
        fc.array(fc.nat(), { maxLength: 400 }),
        fc.array(fc.boolean(), { maxLength: 80 }),
        async (n, order, drops) => {
          const sid = newId('ses');
          const store = createMemorySeqStore(LIMITS);
          const frames: StoredFrame[] = [];
          for (let i = 0; i < n; i += 1) {
            const id = newId('msg');
            const from = newId('mem');
            const frame = stampFrame(
              { t: 'event', id, k: 'reaction', p: reaction() },
              from,
              'ts',
              sid,
            );
            const { seq } = await store.assign(sid, { from, id }, frame, 0);
            frames.push(withSeq(frame, seq));
          }
          const rooms = createRoomRegistry();
          const timers = manualTimers();
          const fanout = createFanOut({
            rooms,
            seq: {
              store,
              submitServer: () => Promise.reject(new Error('unused')),
            },
            setTimer: timers.setTimer,
          });
          const conn = textConnection(new ConnectionRegistry({ max: 10 }), sid);
          rooms.getOrCreate(sid).join(conn, {
            id: conn.entry.memberId ?? '',
            sid,
            role: 'editor',
            userId: newId('usr'),
            workspaceId: null,
            name: 'M',
            slot: 0,
          });
          fanout.release.prime(sid, 1);
          const dispatcher = new ClusterDispatcher({
            redis: { publish: () => Promise.resolve() },
            nodeId: 'me',
            release: fanout.release,
            seq: store,
          });
          // Messages: every frame from another node (some lost), duplicates, and own echoes.
          const messages = frames.flatMap((frame, i) =>
            drops[i] === true ? [] : [JSON.stringify({ node: 'other', sid, frame })],
          );
          for (const k of order) {
            const frame = frames[k % n] as StoredFrame;
            messages.push(JSON.stringify({ node: k % 3 === 0 ? 'me' : 'other', sid, frame }));
          }
          const shuffled = messages
            .map((m, i) => ({ m, k: order[i % Math.max(1, order.length)] ?? i }))
            .sort((a, b) => a.k - b.k)
            .map((x) => x.m);
          for (const m of shuffled) dispatcher.receive(sid, m);
          // Losses: gap timers fire and fan-out fills from the buffer; a lost last frame is found
          // by the reconcile.
          for (let i = 0; i < 5; i += 1) {
            timers.fire();
            await new Promise((resolve) => setImmediate(resolve));
          }
          await dispatcher.reconcile(sid);
          timers.fire();
          await new Promise((resolve) => setImmediate(resolve));
          expect(conn.seqs()).toEqual(range(1, n));
        },
      ),
      { numRuns: 100 },
    );
  });
});
