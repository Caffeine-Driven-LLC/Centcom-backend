/**
 * The presence service (B047, CT-WS-PRESENCE): ephemeral, coalesced, never sequenced.
 *
 * - **Limits per member:** an update goes out at once when the member's last one went out at least
 *   RELAY_PRESENCE_OUT_MS (500 ms) and RELAY_PRESENCE_IN_MS (1 s) ago; otherwise it replaces the
 *   member's pending value (no error, nothing queued) and the latest goes out as soon as both
 *   allow. With the defaults a member's presence goes out at most once a second, and the final
 *   value always does.
 * - **Out:** `{v, t: "presence", sid, from: <member>, ts, k: "presence.update", p}` (no `id`, no
 *   `seq`): written to the store (`presence:{sid}`, 60 s), sent to every welcomed connection of
 *   the session on this node as a droppable frame (B046 drops it under pressure), and published to
 *   the other nodes (B045's ephemeral channel). Never the hot buffer, the durable log or replay.
 * - **Snapshot:** right after a connection's welcome, one frame per member with a presence (from the
 *   store, so other nodes' members too), before any live presence: live frames for that
 *   connection wait until its snapshot went (the latest per member, sent after it).
 * - **Online:** from the connection, never the client: a member is online while it has a
 *   connection here, and for RELAY_OFFLINE_GRACE_MS (10 s) after its last one closed; a reconnect
 *   in the grace keeps it online. When the grace ends, its state goes, and its stored entry if this
 *   node wrote it.
 * - **Bounds:** one entry per member, at most 50 members per session (the session cap); a flood is
 *   overwritten in place.
 *
 * Logs carry sessions and counts only; never a payload.
 *
 * Owns: per-member presence state and its timers. Must not: sequence, buffer or replay presence,
 * or take online/offline from a client.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { ConnectionEntry } from '../connection-registry.js';
import { connectionSender } from '../fanout/fanout.js';
import type { RelayConnection } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import type { PresenceStore } from './store.js';
import {
  PRESENCE_UPDATE,
  type PresenceEntry,
  type PresenceService,
  type PresenceUpdate,
} from './types.js';

/** Members per session at most (CT-WS-ENVELOPE's hard cap). */
export const MAX_MEMBERS = 50;

/** RELAY_PRESENCE_IN_MS, RELAY_PRESENCE_OUT_MS, RELAY_OFFLINE_GRACE_MS. */
export interface PresenceConfig {
  inMs: number;
  outMs: number;
  offlineGraceMs: number;
}

/** A timer that can be cancelled. */
export interface PresenceTimer {
  cancel(): void;
}

/** What the service needs. */
export interface PresenceDeps {
  store: PresenceStore;
  rooms: Pick<RoomRegistry, 'get'>;
  config: PresenceConfig;
  /** This node's id (B045's, looked up when it is needed: the cluster registers later). */
  nodeId: () => string;
  /** Publishes a presence frame to the other nodes (B045's `publishEphemeral`); default none. */
  publish?: (sid: string, frame: Record<string, unknown>) => void;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => PresenceTimer;
  logger?: Logger;
  metrics?: Metrics;
}

interface MemberState {
  /** The value to send next, when one waits. */
  pending: PresenceUpdate | null;
  timer: PresenceTimer | undefined;
  /** When the last value went out (ms); -Infinity before. */
  lastOut: number;
  /** The last value that went out. */
  latest: PresenceEntry | null;
  connections: number;
  grace: PresenceTimer | undefined;
}

const defaultTimer = (fn: () => void, ms: number): PresenceTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** The frame of `member`'s `entry` in `sid`. */
export function presenceFrame(
  sid: string,
  member: string,
  entry: PresenceEntry,
): Record<string, unknown> {
  return {
    v: 1,
    t: 'presence',
    sid,
    from: member,
    ts: new Date(entry.at).toISOString(),
    k: PRESENCE_UPDATE,
    p: entry.p,
  };
}

/** The service, with the welcome hook, remote delivery, session end and `stop`. */
export function createPresence(deps: PresenceDeps): PresenceService & {
  /** After a welcome: the snapshot, then the presence that came meanwhile. */
  welcomed(conn: RelayConnection): Promise<void>;
  /** A presence frame (text) from another node: to this node's welcomed connections. */
  receiveRemote(sid: string, frameText: string): void;
  /** The session ended: its state and stored presence go. */
  endSession(sid: string): Promise<void>;
  /** Members with state, over all sessions (bounds checks). */
  size(): number;
  stop(): void;
} {
  const { config } = deps;
  const clock = deps.clock ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const metrics = deps.metrics ?? noopMetrics;
  const sessions = new Map<string, Map<string, MemberState>>();
  /** Connections waiting for their snapshot: the latest frame per member that came meanwhile. */
  const waiting = new WeakMap<ConnectionEntry, Map<string, string>>();
  let size = 0;

  const counted = (name: string, labels?: Record<string, string>): void =>
    metrics.counter(name, labels).inc();

  function stateOf(sid: string, mid: string, create: boolean): MemberState | undefined {
    let members = sessions.get(sid);
    if (members === undefined) {
      if (!create) return undefined;
      members = new Map();
      sessions.set(sid, members);
    }
    let state = members.get(mid);
    if (state === undefined && create) {
      if (members.size >= MAX_MEMBERS) return undefined;
      state = {
        pending: null,
        timer: undefined,
        lastOut: Number.NEGATIVE_INFINITY,
        latest: null,
        connections: 0,
        grace: undefined,
      };
      members.set(mid, state);
      size += 1;
    }
    return state;
  }

  function forget(sid: string, mid: string): void {
    const members = sessions.get(sid);
    const state = members?.get(mid);
    if (members === undefined || state === undefined) return;
    state.timer?.cancel();
    state.grace?.cancel();
    members.delete(mid);
    size -= 1;
    if (members.size === 0) sessions.delete(sid);
  }

  /** `text` (member `mid`'s presence) to the session's welcomed connections here. */
  function deliverLocal(sid: string, mid: string, text: string): void {
    const room = deps.rooms.get(sid);
    if (room === undefined) return;
    for (const conn of room.connections()) {
      // Not welcomed yet: nothing goes before the welcome.
      if (conn.entry.state !== 'authenticated') continue;
      const held = waiting.get(conn.entry);
      if (held !== undefined) {
        held.set(mid, text);
        continue;
      }
      try {
        const result = connectionSender(conn).send(text, { droppable: true });
        counted('relay_presence_delivered_total', { result });
      } catch {
        counted('relay_presence_delivered_total', { result: 'error' });
      }
    }
  }

  function emit(sid: string, mid: string, state: MemberState): void {
    state.timer = undefined;
    const p = state.pending;
    if (p === null) return;
    state.pending = null;
    const now = clock();
    state.lastOut = now;
    const entry: PresenceEntry = { p, at: now, node: deps.nodeId() };
    state.latest = entry;
    counted('relay_presence_fanouts_total');
    deps.store.write(sid, mid, entry).catch(() => counted('relay_presence_store_failed_total'));
    const frame = presenceFrame(sid, mid, entry);
    deliverLocal(sid, mid, JSON.stringify(frame));
    deps.publish?.(sid, frame);
  }

  const service = {
    update(sid: string, mid: string, p: PresenceUpdate, nowMs: number) {
      const state = stateOf(sid, mid, true);
      if (state === undefined) {
        counted('relay_presence_updates_total', { result: 'over_cap' });
        return;
      }
      state.pending = p;
      if (state.timer !== undefined) {
        // A flood: overwritten in place.
        counted('relay_presence_updates_total', { result: 'coalesced' });
        return;
      }
      counted('relay_presence_updates_total', { result: 'accepted' });
      const due = Math.max(state.lastOut + config.outMs, state.lastOut + config.inMs);
      if (nowMs >= due) emit(sid, mid, state);
      else state.timer = setTimer(() => emit(sid, mid, state), due - nowMs);
    },
    snapshot(sid: string) {
      return [...(sessions.get(sid) ?? [])]
        .filter(([, s]) => s.latest !== null)
        .map(([member, s]) => ({ member, p: (s.latest as PresenceEntry).p }));
    },
    isOnline(sid: string, mid: string) {
      const state = stateOf(sid, mid, false);
      return state !== undefined && (state.connections > 0 || state.grace !== undefined);
    },
    onConnect(sid: string, mid: string) {
      const state = stateOf(sid, mid, true);
      if (state === undefined) return;
      state.connections += 1;
      state.grace?.cancel();
      state.grace = undefined;
    },
    onDisconnect(sid: string, mid: string) {
      const state = stateOf(sid, mid, false);
      if (state === undefined) return;
      state.connections = Math.max(0, state.connections - 1);
      if (state.connections > 0 || state.grace !== undefined) return;
      state.grace = setTimer(() => {
        state.grace = undefined;
        if (state.connections > 0) return;
        counted('relay_presence_offline_total');
        forget(sid, mid);
        deps.store
          .remove(sid, mid, deps.nodeId())
          .catch(() => counted('relay_presence_store_failed_total'));
      }, config.offlineGraceMs);
    },
    async welcomed(conn: RelayConnection) {
      const sid = conn.entry.sessionId;
      if (sid === null) return;
      const held = new Map<string, string>();
      waiting.set(conn.entry, held);
      try {
        let stored: Map<string, PresenceEntry>;
        try {
          stored = await deps.store.read(sid);
        } catch {
          stored = new Map();
        }
        // This node's latest wins over the store (it may not be written yet).
        for (const [mid, state] of sessions.get(sid) ?? []) {
          const mine = state.latest;
          const other = stored.get(mid);
          if (mine !== null && (other === undefined || mine.at >= other.at)) stored.set(mid, mine);
        }
        const sender = connectionSender(conn);
        for (const [mid, entry] of stored) {
          sender.send(JSON.stringify(presenceFrame(sid, mid, entry)), { droppable: true });
        }
        counted('relay_presence_snapshots_total');
        // What came meanwhile is newer: after the snapshot.
        for (const text of held.values()) sender.send(text, { droppable: true });
      } finally {
        waiting.delete(conn.entry);
      }
    },
    receiveRemote(sid: string, frameText: string) {
      let mid: unknown;
      try {
        mid = (JSON.parse(frameText) as Record<string, unknown>)['from'];
      } catch {
        return;
      }
      if (typeof mid === 'string') deliverLocal(sid, mid, frameText);
    },
    async endSession(sid: string) {
      for (const mid of [...(sessions.get(sid)?.keys() ?? [])]) forget(sid, mid);
      await deps.store.clear(sid);
    },
    size: () => size,
    stop() {
      for (const [sid, members] of [...sessions])
        for (const mid of [...members.keys()]) forget(sid, mid);
    },
  };
  return service;
}
