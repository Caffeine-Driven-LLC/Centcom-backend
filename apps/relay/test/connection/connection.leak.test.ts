/**
 * No leaks after churn (B040): after 1 000 connect/disconnect cycles nothing is left: no wheel
 * entry, no platform timer, no close fallback timer, no tracked connection, no registry entry and
 * no close listener, whichever side closed (the peer, the relay with closeConnection, or a dead
 * peer). Run 1 000 times on fake connections (exact counts), and 400 times on a running relay
 * with B011 SimClients (real sockets; fewer, so a loaded machine does not run out of them).
 */
import { describe, expect, it } from 'vitest';
import { closeConnection } from '../../src/connection/close.js';
import { fakeConnection, liveRelay, unitHeartbeat, until } from './helpers.js';

describe('1 000 connect/disconnect cycles', () => {
  it('leave no timers, entries or listeners behind (fake connections)', async () => {
    const { heartbeat, timers, registry, welcome } = unitHeartbeat();
    for (let i = 0; i < 1_000; i += 1) {
      const fake = await welcome(fakeConnection(registry, timers.clock.now));
      timers.clock.advance(1_000);
      switch (i % 4) {
        case 0:
          // The peer leaves.
          fake.closeSocket(1001);
          break;
        case 1:
          // The relay closes it and the socket closes.
          closeConnection(fake.connection, { code: 1000 }, { setTimer: timers.setTimer });
          fake.closeSocket(1000);
          break;
        case 2:
          // The relay closes it and the peer never answers: the fallback cuts it.
          closeConnection(
            fake.connection,
            { code: 4409, bye: 'superseded' },
            { setTimer: timers.setTimer },
          );
          timers.clock.advance(1_000);
          break;
        default:
          // It goes silent: a dead peer, cut 1 s after its close.
          timers.clock.advance(52_000);
      }
      expect(fake.listeners()).toBe(0);
    }
    expect(heartbeat.size).toBe(0);
    expect(heartbeat.wheel.size).toBe(0);
    expect(heartbeat.wheel.timers).toBe(0);
    expect(timers.armed()).toBe(0);
    expect(timers.clock.pending()).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('leave nothing behind on a running relay (400 SimClients)', async () => {
    const live = await liveRelay();
    try {
      for (let round = 0; round < 16; round += 1) {
        const clients = await Promise.all(Array.from({ length: 25 }, () => live.client()));
        await until(() => live.heartbeat.size === 25, 5_000);
        // The relay closes about half; the clients still open then close themselves.
        for (const connection of live.relay.server.connections().slice(0, 12)) {
          closeConnection(connection, { code: 1000 });
        }
        for (const client of clients) if (client.isOpen) await client.close();
        try {
          await until(() => live.relay.registry.size === 0, 10_000);
          await until(() => live.heartbeat.size === 0, 5_000);
        } catch (err) {
          throw new Error(
            `round ${round}: registry ${live.relay.registry.size}, tracked ${live.heartbeat.size}, ` +
              `states ${JSON.stringify(live.relay.registry.entries().map((e) => e.state))}`,
            { cause: err },
          );
        }
        for (const client of clients) client.terminate();
      }
      expect(live.heartbeat.wheel.size).toBe(0);
      expect(live.heartbeat.wheel.timers).toBe(0);
      await until(() => live.timers.armed() === 0, 5_000);
      expect(live.relay.server.connections()).toEqual([]);
    } finally {
      await live.stop();
    }
  }, 120_000);
});
