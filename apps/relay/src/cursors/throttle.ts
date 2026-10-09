/**
 * The cursor throttle (B048, CT-WS-PRESENCE `presence.cursor`): one slot per member holding only its
 * latest cursor, and a tick that sends what changed.
 *
 * - **In:** a member may offer RELAY_CURSOR_IN_PER_S (10) cursors in any one second (the times of
 *   its last 10 accepted, a ring); more are dropped (`dropped_rate`). A `ct` over RELAY_CURSOR_MAX_CT_BYTES (4 KiB, serialised)
 *   is `dropped_size`. An accepted cursor replaces the member's slot: there is no queue.
 * - **Out:** every RELAY_CURSOR_TICK_MS (100 ms) each slot that changed goes out once, to every
 *   welcomed connection of the session on this node but the member's own, as a droppable frame (B046 drops it for a
 *   connection over its soft mark, so a connection never has more than the socket's own buffer),
 *   and to the other nodes (B045's ephemeral channel). A slot that did not change sends nothing.
 * - **Floods:** a member offering more than 10x the limit every second for 10 seconds is closed 4429
 *   (`rate_limited`).
 * - **Opaque:** `ct` is measured (its serialised length, for the cap) and carried as it came; never
 *   read, logged or stored. The frame that goes out is `{v, t, sid, from, ts, k, ct, sig?}` with the
 *   server's `from`.
 *
 * Owns: the slots and the tick. Must not: keep more than one cursor per member, sequence or store a
 * cursor, or look inside `ct`.
 */
import { noopMetrics, type Metrics } from '@centcom/core';
import { CloseCode } from '../close-codes.js';
import { closeConnection } from '../connection/close.js';
import { connectionSender } from '../fanout/fanout.js';
import type { RelayConnection } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import type { CursorsConfig } from './config.js';

/** The cursor kind. */
export const PRESENCE_CURSOR = 'presence.cursor';
/** A flood: more than this many times the limit, every second, for FLOOD_SECONDS. */
export const FLOOD_FACTOR = 10;
export const FLOOD_SECONDS = 10;
/** A slot without an offer for this long is forgotten. */
export const SLOT_IDLE_MS = 60_000;

/** A cursor frame as the stage hands it over (only what the relay carries). */
export interface PresenceCursorFrame {
  ct: unknown;
  sig?: string;
}

/** The card's interface. */
export interface CursorThrottle {
  offer(
    sid: string,
    mid: string,
    frame: PresenceCursorFrame,
    nowMs: number,
  ): 'accepted' | 'dropped_rate' | 'dropped_size';
}

/** A timer that can be cancelled. */
export interface CursorTimer {
  cancel(): void;
}

interface Slot {
  /** The latest accepted cursor, serialised for sending; null once sent. */
  pending: string | null;
  /** The times of the last `inPerSecond` accepted cursors (a ring): at most that many per second. */
  accepted: number[];
  next: number;
  /** Offers in the current one-second window (flood detection). */
  windowStart: number;
  inWindow: number;
  /** Seconds in a row over the flood mark. */
  floodSeconds: number;
  lastOffer: number;
}

/** What the throttle needs. */
export interface CursorThrottleDeps {
  rooms: Pick<RoomRegistry, 'get'>;
  config: Pick<CursorsConfig, 'inPerSecond' | 'tickMs' | 'maxCtBytes'>;
  /** Publishes a cursor frame to the other nodes (B045); default none. */
  publish?: (sid: string, frame: Record<string, unknown>) => void;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => CursorTimer;
  metrics?: Metrics;
}

const defaultTimer = (fn: () => void, ms: number): CursorTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** The throttle, its tick, and what tests and the module need. */
export function createCursorThrottle(deps: CursorThrottleDeps): CursorThrottle & {
  /** Sends every changed slot now (the tick). */
  tick(): void;
  /** Forgets a member's slot (it left the session). */
  forget(sid: string, mid: string): void;
  /** Slots held (one per member at most). */
  slots(): number;
  stop(): void;
} {
  const { config } = deps;
  const clock = deps.clock ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const metrics = deps.metrics ?? noopMetrics;
  const slots = new Map<string, Map<string, Slot>>();
  const dirty = new Set<Slot>();
  const where = new WeakMap<Slot, { sid: string; mid: string }>();
  let timer: CursorTimer | undefined;
  let stopped = false;
  let ticks = 0;

  const count = (result: string): void => metrics.counter('relay_cursors_total', { result }).inc();

  function slotOf(sid: string, mid: string): Slot {
    let members = slots.get(sid);
    if (members === undefined) {
      members = new Map();
      slots.set(sid, members);
    }
    let slot = members.get(mid);
    if (slot === undefined) {
      slot = {
        pending: null,
        accepted: [],
        next: 0,
        windowStart: 0,
        inWindow: 0,
        floodSeconds: 0,
        lastOffer: 0,
      };
      members.set(mid, slot);
      where.set(slot, { sid, mid });
    }
    return slot;
  }

  /** The member's connections here, closed for a flood. */
  function closeFlooder(sid: string, mid: string): void {
    const room = deps.rooms.get(sid);
    for (const conn of room?.connectionsOf(mid) ?? []) {
      closeConnection(conn, { code: CloseCode.RateLimited, errorCode: 'rate_limited' });
    }
    metrics.counter('relay_cursor_flood_closed_total').inc();
  }

  /** A member's cursor to the session's other members here (not back to its own connections). */
  function send(sid: string, mid: string, text: string): void {
    const room = deps.rooms.get(sid);
    if (room === undefined) return;
    for (const conn of room.connections()) {
      if (conn.entry.state !== 'authenticated' || conn.entry.memberId === mid) continue;
      let result: string;
      try {
        result = connectionSender(conn as RelayConnection).send(text, { droppable: true });
      } catch {
        result = 'error';
      }
      metrics.counter('relay_cursors_forwarded_total', { result }).inc();
    }
  }

  function tick(): void {
    ticks += 1;
    for (const slot of dirty) {
      const at = where.get(slot);
      const text = slot.pending;
      slot.pending = null;
      if (at === undefined || text === null) continue;
      send(at.sid, at.mid, text);
      deps.publish?.(at.sid, JSON.parse(text) as Record<string, unknown>);
    }
    dirty.clear();
    // Now and then: slots idle for a minute go.
    if (ticks % 600 === 0) {
      const now = clock();
      for (const [sid, members] of slots) {
        for (const [mid, slot] of members) {
          if (slot.pending === null && now - slot.lastOffer > SLOT_IDLE_MS) members.delete(mid);
        }
        if (members.size === 0) slots.delete(sid);
      }
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimer(() => {
      tick();
      schedule();
    }, config.tickMs);
  }
  schedule();

  return {
    offer(sid, mid, frame, nowMs) {
      const ctText = JSON.stringify(frame.ct);
      if (ctText === undefined || Buffer.byteLength(ctText, 'utf8') > config.maxCtBytes) {
        count('dropped_size');
        return 'dropped_size';
      }
      const slot = slotOf(sid, mid);
      slot.lastOffer = nowMs;
      if (nowMs - slot.windowStart >= 1_000) {
        // A second ended: a flood second if it was a whole second over 10x the limit.
        const flooded =
          nowMs - slot.windowStart < 2_000 && slot.inWindow > config.inPerSecond * FLOOD_FACTOR;
        slot.floodSeconds = flooded ? slot.floodSeconds + 1 : 0;
        slot.windowStart = nowMs;
        slot.inWindow = 0;
        if (slot.floodSeconds >= FLOOD_SECONDS) {
          slot.floodSeconds = 0;
          closeFlooder(sid, mid);
        }
      }
      slot.inWindow += 1;
      // At most `inPerSecond` in any second: the oldest of the last that many must be a second old.
      const oldest = slot.accepted[slot.next];
      if (
        slot.accepted.length >= config.inPerSecond &&
        oldest !== undefined &&
        nowMs - oldest < 1_000
      ) {
        count('dropped_rate');
        return 'dropped_rate';
      }
      slot.accepted[slot.next] = nowMs;
      slot.next = (slot.next + 1) % config.inPerSecond;
      slot.pending =
        `{"v":1,"t":"presence","sid":${JSON.stringify(sid)},"from":${JSON.stringify(mid)},` +
        `"ts":${JSON.stringify(new Date(nowMs).toISOString())},"k":"${PRESENCE_CURSOR}","ct":${ctText}` +
        (frame.sig === undefined ? '}' : `,"sig":${JSON.stringify(frame.sig)}}`);
      dirty.add(slot);
      count('accepted');
      return 'accepted';
    },
    tick,
    forget(sid, mid) {
      const members = slots.get(sid);
      const slot = members?.get(mid);
      if (members === undefined || slot === undefined) return;
      dirty.delete(slot);
      members.delete(mid);
      if (members.size === 0) slots.delete(sid);
    },
    slots: () => [...slots.values()].reduce((n, m) => n + m.size, 0),
    stop() {
      stopped = true;
      timer?.cancel();
    },
  };
}
