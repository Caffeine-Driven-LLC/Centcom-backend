/**
 * Session rooms (B043): this node's in-memory registry of who is connected to which session.
 *
 * - `getOrCreate(sid)` is synchronous, so a join racing an eviction gets either the live room or a
 *   fresh one, never one being removed.
 * - A room tracks connections per member (a member may connect from several devices; each is one
 *   connection, the member counted once).
 * - When its last connection leaves, a room is evicted `evictAfterMs` (60 s) later unless someone
 *   joins first; one timer per empty room.
 * - `closeMember` closes every connection of a member (through B040's `closeConnection`, so the
 *   right `sys.error` precedes the code) and drops them from the room at once.
 *
 * Room state is per node: nothing here is global truth (cross-node routing is B045).
 *
 * Owns: rooms, their members and connections, eviction. Must not: authorise anything (the stage
 * does), or keep a connection after it left.
 */
import type { ErrorCode } from '@centcom/core';
import { CloseCode, type CloseCodeValue } from '../close-codes.js';
import { closeConnection } from '../connection/close.js';
import type { ConnectionEntry } from '../connection-registry.js';
import type { RelayConnection } from '../pipeline.js';
import type { MemberRole, SessionRole } from './kind-policy.js';

/** An empty room is evicted this long after its last connection left. */
export const ROOM_EVICT_AFTER_MS = 60_000;

/** A member as the room knows them. */
export interface MemberView extends MemberRole {
  /** The member's user (`usr_`), to match workspace membership events. */
  userId: string;
  /** The session's workspace (`wsp_`); null for a session outside any workspace. */
  workspaceId: string | null;
  /** Display name and slot, as the welcome gave them. */
  name: string;
  slot: number;
}

/** One session's room on this node. */
export interface Room {
  readonly sid: string;
  /** Adds `conn` for member `m` (a member's view is replaced by the newest one). */
  join(conn: RelayConnection, m: MemberView): void;
  /** Removes `conn` (idempotent); the member goes when their last connection does. */
  leave(conn: RelayConnection): void;
  /** The members with at least one connection here. */
  members(): MemberView[];
  connections(): Iterable<RelayConnection>;
  connectionsOf(memberId: string): RelayConnection[];
  /** Closes every connection of `memberId` with `code` and drops them from the room. */
  closeMember(memberId: string, code: number, errorCode?: ErrorCode): void;
  /** The member `conn` joined as, or undefined. */
  memberOf(conn: RelayConnection): MemberView | undefined;
  /** True when `memberId` has a connection here. */
  hasMember(memberId: string): boolean;
  /** Distinct members connected. */
  memberCount(): number;
  /** Sets a member's role (a live change: the membership record or a `role_changed` event). */
  setRole(memberId: string, role: SessionRole): void;
}

/** The rooms of this node. */
export interface RoomRegistry {
  get(sid: string): Room | undefined;
  getOrCreate(sid: string): Room;
  count(): number;
  /** Every room. */
  rooms(): Iterable<Room>;
  /** The room and member `conn` joined as, or undefined. */
  locate(conn: RelayConnection): { room: Room; member: MemberView } | undefined;
  /**
   * B045: told of every join and leave on this node, after the room changed (`room.memberCount()`,
   * `room.hasMember` already reflect it). A listener that throws is skipped.
   */
  listen(listener: RoomListener): void;
}

/** Joins and leaves on this node (B045's subscriptions). */
export interface RoomListener {
  joined?(room: Room, conn: RelayConnection, member: MemberView): void;
  left?(room: Room, conn: RelayConnection, member: MemberView): void;
}

/** A timer that can be cancelled. */
export interface RoomTimer {
  cancel(): void;
}

/** Options for `createRoomRegistry`. */
export interface RoomRegistryOptions {
  /** Default ROOM_EVICT_AFTER_MS. */
  evictAfterMs?: number;
  /** Runs `fn` after `ms`; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => RoomTimer;
}

const defaultTimer = (fn: () => void, ms: number): RoomTimer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

/** The `sys.error` code that precedes a member's close, by close code. */
const CLOSE_ERROR: Partial<Record<number, ErrorCode>> = {
  [CloseCode.Forbidden]: 'not_a_member',
  [CloseCode.NotFound]: 'session_ended',
};

/** A new, empty registry. */
export function createRoomRegistry(options: RoomRegistryOptions = {}): RoomRegistry {
  const evictAfterMs = options.evictAfterMs ?? ROOM_EVICT_AFTER_MS;
  const setTimer = options.setTimer ?? defaultTimer;
  const rooms = new Map<string, Room>();
  /** Where each connection is, for the stage's lookup. */
  const placed = new WeakMap<ConnectionEntry, { room: Room; member: MemberView }>();
  const listeners: RoomListener[] = [];
  const tell = (event: 'joined' | 'left', room: Room, conn: RelayConnection, m: MemberView) => {
    for (const listener of listeners) {
      try {
        listener[event]?.(room, conn, m);
      } catch {
        // A listener's failure is its own; the room is unchanged by it.
      }
    }
  };

  function createRoom(sid: string): Room {
    /** member id → view; member id → connections. */
    const views = new Map<string, MemberView>();
    const conns = new Map<string, Set<RelayConnection>>();
    let evictTimer: RoomTimer | undefined;

    const scheduleEviction = (): void => {
      evictTimer?.cancel();
      evictTimer = setTimer(() => {
        evictTimer = undefined;
        if (conns.size === 0 && rooms.get(sid) === room) rooms.delete(sid);
      }, evictAfterMs);
    };

    const room: Room = {
      sid,
      join(conn, m) {
        evictTimer?.cancel();
        evictTimer = undefined;
        const previous = placed.get(conn.entry);
        if (previous !== undefined && previous.room !== room) previous.room.leave(conn);
        let set = conns.get(m.id);
        if (set === undefined) {
          set = new Set();
          conns.set(m.id, set);
        }
        set.add(conn);
        views.set(m.id, { ...m, sid });
        const view = views.get(m.id) ?? m;
        placed.set(conn.entry, { room, member: view });
        tell('joined', room, conn, view);
      },
      leave(conn) {
        const where = placed.get(conn.entry);
        if (where?.room !== room) return;
        placed.delete(conn.entry);
        const set = conns.get(where.member.id);
        set?.delete(conn);
        if (set !== undefined && set.size === 0) {
          conns.delete(where.member.id);
          views.delete(where.member.id);
        }
        if (conns.size === 0) scheduleEviction();
        tell('left', room, conn, where.member);
      },
      members: () => [...views.values()].map((v) => ({ ...v })),
      *connections() {
        for (const set of conns.values()) yield* set;
      },
      connectionsOf: (memberId) => [...(conns.get(memberId) ?? [])],
      closeMember(memberId, code, errorCode) {
        for (const conn of [...(conns.get(memberId) ?? [])]) {
          room.leave(conn);
          const error = errorCode ?? CLOSE_ERROR[code];
          closeConnection(conn, {
            code: code as CloseCodeValue,
            ...(error === undefined ? {} : { errorCode: error }),
          });
        }
      },
      memberOf: (conn) => {
        const where = placed.get(conn.entry);
        return where?.room === room ? views.get(where.member.id) : undefined;
      },
      hasMember: (memberId) => conns.has(memberId),
      memberCount: () => conns.size,
      setRole(memberId, role) {
        const view = views.get(memberId);
        if (view !== undefined) view.role = role;
      },
    };
    return room;
  }

  return {
    get: (sid) => rooms.get(sid),
    getOrCreate(sid) {
      let room = rooms.get(sid);
      if (room === undefined) {
        room = createRoom(sid);
        rooms.set(sid, room);
      }
      return room;
    },
    count: () => rooms.size,
    rooms: () => rooms.values(),
    locate(conn) {
      const where = placed.get(conn.entry);
      if (where === undefined) return undefined;
      const member = where.room.memberOf(conn);
      return member === undefined ? undefined : { room: where.room, member };
    },
    listen(listener) {
      listeners.push(listener);
    },
  };
}
