/**
 * Test helpers for backpressure (B046):
 *
 * - `bufferedConnection()`: a connection whose outbound buffer fills with what it is sent (as a
 *   socket a client stopped reading) and drains by `drain(bytes)`, or is set outright (`buffered`);
 * - `controllerUnit()`: the controller on manual timers and a manual clock, with `connect()`
 *   (attached, as the module attaches every connection) and `send()` / `sendEphemeral()` through
 *   B044's `ConnectionSender`, which consults it;
 * - `frameText(seq, bytes)`: a sequenced frame of about `bytes` (opaque ciphertext).
 */
import { newId } from '@centcom/contracts';
import { createBackpressure } from '../../src/backpressure/controller.js';
import type { BackpressureConfig } from '../../src/backpressure/config.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { connectionSender } from '../../src/fanout/fanout.js';
import { manualTimers, textConnection, type TextConnection } from '../fanout/helpers.js';
import { recordingMetrics } from '../helpers.js';

export const KiB = 1024;
export const MiB = 1024 * KiB;

export const CONFIG: BackpressureConfig = {
  hardBytes: 2 * MiB,
  softBytes: MiB,
  graceMs: 5_000,
  nodeMaxBytes: 1024 * MiB,
};

/** A connection with an outbound buffer the test controls. */
export interface BufferedConnection extends TextConnection {
  buffered: number;
  maxBuffered: number;
  drain(bytes?: number): void;
}

export function bufferedConnection(
  registry: ConnectionRegistry,
  sid = newId('ses'),
): BufferedConnection {
  const conn = textConnection(registry, sid) as BufferedConnection;
  conn.buffered = 0;
  conn.maxBuffered = 0;
  const sendText = conn.sendText?.bind(conn);
  conn.sendText = (text) => {
    const ok = sendText?.(text) ?? false;
    if (ok) {
      conn.buffered += Buffer.byteLength(text, 'utf8');
      conn.maxBuffered = Math.max(conn.maxBuffered, conn.buffered);
    }
    return ok;
  };
  conn.bufferedBytes = () => conn.buffered;
  conn.drain = (bytes = Number.POSITIVE_INFINITY) => {
    conn.buffered = Math.max(0, conn.buffered - bytes);
  };
  return conn;
}

/** A sequenced frame's text of about `bytes`. */
export function frameText(sid: string, seq: number, bytes = 100 * KiB): string {
  return JSON.stringify({
    v: 1,
    t: 'event',
    id: newId('msg'),
    sid,
    from: newId('mem'),
    ts: '2026-10-09T00:00:00.000Z',
    seq,
    k: 'message.user',
    ct: {
      alg: 'xchacha20poly1305',
      kid: 'k1',
      n: 'n'.repeat(32),
      c: 'c'.repeat(Math.max(0, bytes - 300)),
    },
  });
}

/** A presence frame's text (droppable). */
export const presenceText = (sid: string): string =>
  JSON.stringify({
    v: 1,
    t: 'presence',
    sid,
    from: newId('mem'),
    k: 'presence.cursor',
    p: { x: 1 },
  });

export function controllerUnit(config: Partial<BackpressureConfig> = {}) {
  const timers = manualTimers();
  let now = 0;
  const recorded = recordingMetrics();
  const controller = createBackpressure({
    config: { ...CONFIG, ...config },
    clock: () => now,
    setTimer: timers.setTimer,
    random: () => 0.5,
    metrics: recorded.metrics,
  });
  const registry = new ConnectionRegistry({ max: 10_000 });
  const sid = newId('ses');
  return {
    controller,
    timers,
    recorded,
    registry,
    sid,
    advance(ms: number) {
      now += ms;
    },
    /** Fires the timers due at `ms` exactly (grace 5 000, jitter 250 with random 0.5). */
    fire(ms: number) {
      for (const t of timers.pending.filter((x) => x.ms === ms && x.live)) {
        t.live = false;
        t.fn();
      }
    },
    connect(): BufferedConnection {
      const conn = bufferedConnection(registry, sid);
      controller.attach(conn);
      return conn;
    },
    send: (conn: BufferedConnection, text: string) =>
      connectionSender(conn).send(text, { droppable: false }),
    sendEphemeral: (conn: BufferedConnection, text: string) =>
      connectionSender(conn).send(text, { droppable: true }),
  };
}

/** The `sys.*` frames a connection got, by type. */
export const sysOf = (conn: TextConnection, t: string) => conn.frames().filter((f) => f['t'] === t);
