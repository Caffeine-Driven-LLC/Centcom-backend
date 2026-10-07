/**
 * PubSub contract (B009 acceptance 1 and 6): the same cases against every backend. Delivery,
 * order per channel, separate channels, several handlers, unsubscribe, a handler that throws
 * (logged without the message; the subscription goes on), and argument limits. On Redis also the
 * namespace of channels and a subscriber that reconnects after its connection is killed.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VALUE_BYTES, type PubSub } from '../../src/index.js';
import { HARNESSES, REDIS_URL, redisHarness, until, type Harness } from './helpers.js';

for (const [name, open, enabled] of HARNESSES) {
  describe.runIf(enabled)(`PubSub contract: ${name}`, () => {
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });
    const setup = async (): Promise<{ bus: PubSub; h: Harness }> => {
      harness = await open();
      return { bus: harness.backend.pubsub, h: harness };
    };

    it('delivers messages published after subscribing, in order per channel', async () => {
      const { bus } = await setup();
      await bus.publish('news', 'before anyone listens');
      const received: string[] = [];
      await bus.subscribe('news', (m) => received.push(m));
      const sent = Array.from({ length: 100 }, (_, i) => `message ${i}`);
      for (const m of sent) await bus.publish('news', m);
      await until(() => received.length === sent.length);
      expect(received).toEqual(sent);
    });

    it('keeps channels apart and gives every handler of a channel each message', async () => {
      const { bus } = await setup();
      const a: string[] = [];
      const b1: string[] = [];
      const b2: string[] = [];
      await bus.subscribe('a', (m) => a.push(m));
      await bus.subscribe('b', (m) => b1.push(m));
      await bus.subscribe('b', (m) => b2.push(m));
      await bus.publish('a', 'for a');
      await bus.publish('b', 'for b');
      await until(() => a.length === 1 && b1.length === 1 && b2.length === 1);
      expect([a, b1, b2]).toEqual([['for a'], ['for b'], ['for b']]);
    });

    it('stops delivering to a handler once it unsubscribes, and only to that one', async () => {
      const { bus } = await setup();
      const kept: string[] = [];
      const dropped: string[] = [];
      await bus.subscribe('c', (m) => kept.push(m));
      const unsubscribe = await bus.subscribe('c', (m) => dropped.push(m));
      await bus.publish('c', 'one');
      await until(() => kept.length === 1 && dropped.length === 1);
      await unsubscribe();
      await unsubscribe(); // a second call does nothing
      await bus.publish('c', 'two');
      await until(() => kept.length === 2);
      await sleep(50);
      expect(dropped).toEqual(['one']);
    });

    it('stops all delivery once the last handler of a channel unsubscribes', async () => {
      const { bus } = await setup();
      const received: string[] = [];
      const unsubscribe = await bus.subscribe('d', (m) => received.push(m));
      await unsubscribe();
      await bus.publish('d', 'nobody listens');
      await sleep(100);
      expect(received).toEqual([]);
      // Subscribing again works.
      await bus.subscribe('d', (m) => received.push(m));
      await bus.publish('d', 'back');
      await until(() => received.length === 1);
    });

    it('logs a handler that throws, without the message, and keeps its subscription', async () => {
      const { bus, h } = await setup();
      const received: string[] = [];
      await bus.subscribe('e', (m) => {
        if (m.startsWith('poison')) JSON.parse(m); // throws a SyntaxError that quotes the message
        received.push(m);
      });
      await bus.publish('e', 'poison secret-payload-words');
      await bus.publish('e', 'fine');
      await until(() => received.length === 1);
      expect(received).toEqual(['fine']);
      await until(() => h.counters.count('redis_pubsub_handler_errors_total') === 1);
      const line = h.log.lines().find((l) => l['msg'] === 'redis.pubsub.handler_failed');
      expect(line).toMatchObject({ level: 'warn', error_type: 'SyntaxError' });
      expect(h.log.raw()).not.toContain('secret-payload-words');
    });

    it('refuses bad channels, messages and handlers', async () => {
      const { bus } = await setup();
      await expect(bus.publish('', 'm')).rejects.toThrow(TypeError);
      await expect(bus.publish('f', 'x'.repeat(MAX_VALUE_BYTES + 1))).rejects.toThrow(RangeError);
      await expect(
        bus.subscribe('f', 'not a function' as unknown as (m: string) => void),
      ).rejects.toThrow(TypeError);
    });
  });
}

describe.runIf(REDIS_URL !== undefined)('pub/sub on Redis', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('publishes under the ct:<env>: namespace', async () => {
    harness = await redisHarness();
    const { backend, admin, prefix } = harness;
    if (admin === undefined) throw new Error('the Redis harness has an admin client');
    const raw: string[] = [];
    const listener = admin.duplicate();
    await listener.subscribe(`${prefix}ns`);
    listener.on('message', (_channel: string, message: string) => raw.push(message));
    try {
      await backend.pubsub.publish('ns', 'namespaced');
      await until(() => raw.length === 1);
      expect(raw).toEqual(['namespaced']);
    } finally {
      listener.disconnect();
    }
  });

  it('reconnects after its connection is killed and receives what is published afterwards within 5 s (acceptance 6)', async () => {
    harness = await redisHarness();
    const { backend, admin, counters, log } = harness;
    if (admin === undefined) throw new Error('the Redis harness has an admin client');
    const received: string[] = [];
    await backend.pubsub.subscribe('survivor', (m) => received.push(m));
    await backend.pubsub.publish('survivor', 'before');
    await until(() => received.includes('before'));

    // What a server restart does to a subscriber: its connection drops.
    await admin.call('CLIENT', 'KILL', 'TYPE', 'pubsub');
    const killedAt = performance.now();
    // Messages published while it reconnects are lost (pub/sub keeps nothing), so keep publishing.
    let n = 0;
    while (!received.some((m) => m.startsWith('after-')) && performance.now() - killedAt < 5_000) {
      await backend.pubsub.publish('survivor', `after-${n++}`);
      await sleep(100);
    }
    expect(received.some((m) => m.startsWith('after-'))).toBe(true);
    expect(performance.now() - killedAt).toBeLessThan(5_000);
    await until(() => counters.count('redis_reconnects_total') >= 1);
    expect(
      log.lines().some((l) => l['msg'] === 'redis.reconnected' && l['role'] === 'subscriber'),
    ).toBe(true);
  }, 15_000);
});
