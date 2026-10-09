/**
 * Test helpers for cursors and typing (B048): the throttle and the stage on a fake clock (the tick
 * fires as time advances), rooms with welcomed connections, and opaque random `ct` objects of a
 * chosen serialised size (the relay must not interpret them).
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import type { CursorsConfig } from '../../src/cursors/config.js';
import { cursorStage } from '../../src/cursors/stage.js';
import { createCursorThrottle } from '../../src/cursors/throttle.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { textConnection, type TextConnection } from '../fanout/helpers.js';
import { recordingMetrics } from '../helpers.js';
import { fakeTime } from '../presence/helpers.js';

export { fakeTime };

export const CONFIG: CursorsConfig = {
  inPerSecond: 10,
  tickMs: 100,
  typingTtlMs: 5_000,
  maxCtBytes: 4_096,
};

/** An opaque `ct` whose JSON is exactly `bytes` long (random base64url in `c`). */
export function ctOf(bytes = 200): Record<string, string> {
  const base = { alg: 'xchacha20poly1305', kid: 'k1', n: 'n'.repeat(32), c: '' };
  const room = bytes - JSON.stringify(base).length;
  if (room < 0) throw new RangeError('too small');
  base.c = randomBytes(room).toString('base64url').slice(0, room);
  return base;
}

export function cursorUnit(config: Partial<CursorsConfig> = {}) {
  const time = fakeTime();
  const recorded = recordingMetrics();
  const rooms = createRoomRegistry();
  const published: Record<string, unknown>[] = [];
  const throttle = createCursorThrottle({
    rooms,
    config: { ...CONFIG, ...config },
    publish: (_sid, frame) => void published.push(frame),
    clock: time.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
    metrics: recorded.metrics,
  });
  const stage = cursorStage({ throttle, clock: time.now });
  const registry = new ConnectionRegistry({ max: 10_000 });
  const sid = newId('ses');

  function join(member = newId('mem'), session = sid): TextConnection {
    const conn = textConnection(registry, session, member);
    rooms.getOrCreate(session).join(conn, {
      id: member,
      sid: session,
      role: 'editor',
      userId: newId('usr'),
      workspaceId: null,
      name: 'M',
      slot: 0,
    });
    return conn;
  }

  /** A `presence.cursor` from `conn` through the stage; true when it went no further. */
  async function cursor(
    conn: RelayConnection,
    ct: unknown = ctOf(),
    extra: Record<string, unknown> = {},
  ) {
    const frame = {
      v: 1,
      t: 'presence',
      sid: conn.entry.sessionId,
      k: 'presence.cursor',
      ct,
      sig: 's'.repeat(86),
      ...extra,
    };
    let passed = false;
    await stage({ connection: conn, raw: '', frame, state: {} }, () => {
      passed = true;
      return Promise.resolve();
    });
    return !passed;
  }

  return { time, recorded, rooms, throttle, stage, published, registry, sid, join, cursor };
}

/** The cursor frames a connection got. */
export const cursorsOf = (conn: TextConnection, from?: string) =>
  conn
    .frames()
    .filter((f) => f['k'] === 'presence.cursor' && (from === undefined || f['from'] === from));
