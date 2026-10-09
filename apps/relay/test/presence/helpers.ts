/**
 * Test helpers for presence (B047):
 *
 * - `fakeTime()`: a clock and timers that fire in due order as the test advances time;
 * - `presenceUnit()`: the service over the in-memory store, rooms, and the stage; `join()` a
 *   welcomed member's connection (B043's join drives online/offline), `update()` a
 *   `presence.update` through the stage, `presenceOf(conn)` what a connection got.
 */
import { newId } from '@centcom/contracts';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { createPresence, type PresenceConfig } from '../../src/presence/service.js';
import { presenceStage } from '../../src/presence/stage.js';
import { createMemoryPresenceStore, type PresenceStore } from '../../src/presence/store.js';
import { createRoomRegistry } from '../../src/rooms/registry.js';
import { textConnection, type TextConnection } from '../fanout/helpers.js';
import { recordingMetrics } from '../helpers.js';

/** A clock and timers the test moves. */
export function fakeTime(start = 1_000_000) {
  let now = start;
  const timers: { due: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      const t = { due: now + ms, fn, live: true };
      timers.push(t);
      return { cancel: () => void (t.live = false) };
    },
    /** Moves to `to`, firing every timer due by then, in order. */
    advanceTo(to: number) {
      for (;;) {
        const next = timers.filter((t) => t.live && t.due <= to).sort((a, b) => a.due - b.due)[0];
        if (next === undefined) break;
        next.live = false;
        now = Math.max(now, next.due);
        next.fn();
      }
      now = Math.max(now, to);
    },
    advance(ms: number) {
      this.advanceTo(now + ms);
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}

export const CONFIG: PresenceConfig = { inMs: 1_000, outMs: 500, offlineGraceMs: 10_000 };

export function presenceUnit(
  opts: { config?: Partial<PresenceConfig>; store?: PresenceStore; nodeId?: string } = {},
) {
  const time = fakeTime();
  const recorded = recordingMetrics();
  const rooms = createRoomRegistry();
  const store = opts.store ?? createMemoryPresenceStore(time.now);
  const published: { sid: string; frame: Record<string, unknown> }[] = [];
  const presence = createPresence({
    store,
    rooms,
    config: { ...CONFIG, ...opts.config },
    nodeId: () => opts.nodeId ?? 'node-a',
    publish: (sid, frame) => void published.push({ sid, frame }),
    clock: time.now,
    setTimer: (fn, ms) => time.setTimer(fn, ms),
    metrics: recorded.metrics,
  });
  rooms.listen({
    joined: (room, _c, m) => presence.onConnect(room.sid, m.id),
    left: (room, _c, m) => presence.onDisconnect(room.sid, m.id),
  });
  const stage = presenceStage({ service: presence, clock: time.now, metrics: recorded.metrics });
  const registry = new ConnectionRegistry({ max: 10_000 });
  const sid = newId('ses');

  /** A welcomed connection of `member` in `session`. */
  function join(
    member = newId('mem'),
    session = sid,
    role: 'host' | 'editor' | 'viewer' = 'editor',
  ): TextConnection {
    const conn = textConnection(registry, session, member);
    rooms.getOrCreate(session).join(conn, {
      id: member,
      sid: session,
      role,
      userId: newId('usr'),
      workspaceId: null,
      name: 'M',
      slot: 0,
    });
    conn.onClose(() => rooms.locate(conn)?.room.leave(conn));
    return conn;
  }

  /** A `presence.update` from `conn` through the stage; true when it went no further. */
  async function update(
    conn: RelayConnection,
    p: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    const frame = {
      v: 1,
      t: 'presence',
      sid: conn.entry.sessionId,
      k: 'presence.update',
      p,
      ...extra,
    };
    let passed = false;
    await stage({ connection: conn, raw: JSON.stringify(frame), frame, state: {} }, () => {
      passed = true;
      return Promise.resolve();
    });
    return !passed;
  }

  return { time, recorded, rooms, store, presence, published, stage, registry, sid, join, update };
}

/** The presence frames a connection got, as `[member, p]`. */
export const presenceOf = (conn: TextConnection): [string, Record<string, unknown>][] =>
  conn
    .frames()
    .filter((f) => f['t'] === 'presence')
    .map((f) => [f['from'] as string, f['p'] as Record<string, unknown>]);

export const ONLINE_IDLE = { status: 'online', activity: 'idle' } as const;
