/**
 * The hello deadline (B038 acceptance 1; tests "handshake.timeout.test.ts"): on a fake clock, a
 * connection that sends nothing gets `sys.error` and close 4408 when the 5 s timer fires, and one
 * whose hello arrived in time is left alone; frames that arrive while a hello is being checked are
 * dropped. On a real socket the close lands between 5.0 and 5.5 s after the upgrade.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { CloseCode } from '../../src/close-codes.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { createHandshake, HELLO_TIMEOUT_MS } from '../../src/handshake/handshake.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { recordingMetrics } from '../helpers.js';
import {
  first,
  handshakeRelay,
  hello,
  memoryAccess,
  mintTicket,
  send,
  signingKey,
  TEST_HANDSHAKE_CONFIG,
  ticketFor,
} from './helpers.js';

/** A connection the test drives by hand. */
function fakeConnection(registry: ConnectionRegistry) {
  const entry = registry.add('127.0.0.1');
  const sent: Record<string, unknown>[] = [];
  const closes: number[] = [];
  const connection: RelayConnection = {
    entry,
    send: (frame) => {
      sent.push(frame as Record<string, unknown>);
      return true;
    },
    close: (code) => {
      entry.state = 'closing';
      closes.push(code);
    },
    terminate: () => undefined,
  };
  return { connection, sent, closes };
}

function fakeTimers() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      pending.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    fire(ms: number) {
      for (const t of pending) if (t.ms === ms && !t.cancelled) t.fn();
    },
  };
}

describe('the hello deadline on a fake clock', () => {
  it('closes a silent connection with sys.error and 4408 when 5 s pass', () => {
    const registry = new ConnectionRegistry({ max: 10 });
    const timers = fakeTimers();
    const { metrics, count } = recordingMetrics();
    const handshake = createHandshake({
      config: TEST_HANDSHAKE_CONFIG,
      jwks: { key: () => Promise.reject(new Error('unused')) },
      kv: createMemoryRedis().kv,
      access: memoryAccess(),
      registry,
      metrics,
      setTimer: timers.setTimer,
    });
    const { connection, sent, closes } = fakeConnection(registry);
    handshake.onConnection(connection);
    expect(timers.pending.map((t) => t.ms)).toEqual([HELLO_TIMEOUT_MS]);
    expect(sent).toEqual([]);
    timers.fire(HELLO_TIMEOUT_MS);
    expect(closes).toEqual([CloseCode.HandshakeTimeout]);
    expect(sent[0]).toMatchObject({ v: 1, t: 'sys.error', p: { code: 'protocol_violation' } });
    expect(count('relay_handshakes_total', { outcome: 'timeout' })).toBe(1);
  });

  it('cancels the deadline when the hello arrives, and drops frames sent meanwhile', async () => {
    const registry = new ConnectionRegistry({ max: 10 });
    const timers = fakeTimers();
    const { metrics, count } = recordingMetrics();
    let release: () => void = () => undefined;
    const handshake = createHandshake({
      config: TEST_HANDSHAKE_CONFIG,
      jwks: {
        key: () =>
          new Promise((_resolve, reject) => {
            release = () => reject(new Error('stop here'));
          }),
      },
      kv: createMemoryRedis().kv,
      access: memoryAccess(),
      registry,
      metrics,
      setTimer: timers.setTimer,
    });
    const { connection, closes } = fakeConnection(registry);
    handshake.onConnection(connection);
    const key = signingKey();
    const raw = JSON.stringify(hello(await mintTicket(key, ticketFor())));
    const checking = handshake.stage({ connection, raw, state: {} }, () => Promise.resolve());
    await handshake.stage({ connection, raw: '{"v":1,"t":"sys.ping","p":{}}', state: {} }, () =>
      Promise.reject(new Error('must not pass')),
    );
    expect(count('relay_handshake_frames_dropped_total')).toBe(1);
    timers.fire(HELLO_TIMEOUT_MS);
    expect(closes).toEqual([]);
    release();
    await checking;
    expect(closes).toEqual([CloseCode.Unauthenticated]);
  });

  it('does nothing when the connection closed before the deadline', () => {
    const registry = new ConnectionRegistry({ max: 10 });
    const timers = fakeTimers();
    const handshake = createHandshake({
      config: TEST_HANDSHAKE_CONFIG,
      jwks: { key: () => Promise.reject(new Error('unused')) },
      kv: createMemoryRedis().kv,
      access: memoryAccess(),
      registry,
      setTimer: timers.setTimer,
    });
    const { connection, sent, closes } = fakeConnection(registry);
    handshake.onConnection(connection);
    registry.remove(connection.entry.id);
    timers.fire(HELLO_TIMEOUT_MS);
    expect(sent).toEqual([]);
    expect(closes).toEqual([]);
  });
});

describe('the hello deadline on a socket', () => {
  it('closes 4408 between 5.0 and 5.5 s after the upgrade', async () => {
    const h = await handshakeRelay();
    try {
      const c = h.open();
      await c.opened;
      const opened = Date.now();
      const closed = await c.closed;
      const error = c.messages.find((m) => m['t'] === 'sys.error');
      expect(closed.code).toBe(4408);
      expect(closed.at - opened).toBeGreaterThanOrEqual(4_950);
      expect(closed.at - opened).toBeLessThanOrEqual(5_500);
      expect(error?.['p']).toMatchObject({ code: 'protocol_violation' });
    } finally {
      await h.stop();
    }
  }, 15_000);

  it('does not close a connection that sent its hello in time', async () => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor();
      h.access.allow(claims);
      const c = h.open();
      await send(c, hello(await mintTicket(h.key, claims)));
      await first(c, 'sys.welcome');
      const outcome = await Promise.race([
        c.closed.then(() => 'closed'),
        new Promise((r) => setTimeout(() => r('open'), 5_600)),
      ]);
      expect(outcome).toBe('open');
    } finally {
      await h.stop();
    }
  }, 15_000);
});
