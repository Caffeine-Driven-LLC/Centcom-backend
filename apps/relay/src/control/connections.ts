/**
 * Connections on every node (B051's `ConnectionRegistryPort`).
 *
 * - **Connected anywhere** (`isConnected`, for `control.transfer_host`): a member with a connection
 *   here is connected. Otherwise the relay reads `relay:ses:{sid}:on:{mid}`, a marker each node
 *   writes for every member connected to it:
 *   - written on the member's first connection here;
 *   - refreshed every `refreshMs` (10 s), with a `ttlMs` (30 s) lifetime;
 *   - deleted when its last connection here closes.
 *
 *   A member still connected to another node is marked again by that node's next refresh, so for
 *   up to 10 s after leaving one node it may read as offline (a transfer then is refused; the host
 *   tries again). A crashed node's markers expire within 30 s.
 * - **Closing** goes through B045's member control (every node), or this node's rooms when the
 *   relay has no cluster module. 4403 is preceded by `sys.error not_a_member`.
 * - **Refresh:** this node's cached membership (B043, 2 s) and the room's role are read again at
 *   once; other nodes read them within 2 s (CT-RBAC rule 2).
 *
 * Owns: the markers. Must not: decide who is closed (the handler does).
 */
import type { ErrorCode, KeyValue, Logger } from '@centcom/core';
import type { ClusterNode } from '../cluster/node.js';
import { CloseCode } from '../close-codes.js';
import type { LiveMembership } from '../rooms/membership.js';
import type { RoomRegistry } from '../rooms/registry.js';
import type { ConnectionRegistryPort } from './ports.js';

/** A marker lives this long without a refresh. */
export const CONNECTED_TTL_MS = 30_000;
/** Each node refreshes its members' markers this often. */
export const CONNECTED_REFRESH_MS = 10_000;

/** The marker of `mid` connected to `sid` (braces: a Redis Cluster hash tag). */
export const connectedKey = (sid: string, mid: string): string => `relay:ses:{${sid}}:on:${mid}`;

/** What the port needs. */
export interface ConnectionsDeps {
  rooms: RoomRegistry;
  kv: Pick<KeyValue, 'get' | 'set' | 'del'>;
  membership: Pick<LiveMembership, 'refresh'>;
  /** B045, looked up when a member is closed (its module registers later). */
  cluster: () => Pick<ClusterNode, 'memberControl'> | undefined;
  logger?: Logger;
  ttlMs?: number;
  refreshMs?: number;
  /** Runs `fn` every `ms`; default an unref'd setInterval. */
  every?: (fn: () => void, ms: number) => { cancel(): void };
}

const defaultEvery = (fn: () => void, ms: number) => {
  const handle = setInterval(fn, ms);
  handle.unref();
  return { cancel: () => clearInterval(handle) };
};

/** The port, with the markers' upkeep (`start` once, `stop` on shutdown). */
export function createConnections(deps: ConnectionsDeps): ConnectionRegistryPort & {
  start(): void;
  stop(): void;
} {
  const ttlMs = deps.ttlMs ?? CONNECTED_TTL_MS;
  const quiet = (task: Promise<unknown>): void => {
    task.catch((err: unknown) => {
      deps.logger?.debug(
        { error: err instanceof Error ? err.name : typeof err },
        'relay.connected_marker_failed',
      );
    });
  };
  const mark = (sid: string, mid: string) =>
    quiet(deps.kv.set(connectedKey(sid, mid), '1', { ttlMs }));
  let timer: { cancel(): void } | undefined;

  return {
    start() {
      deps.rooms.listen({
        joined(room, _conn, member) {
          if (room.connectionsOf(member.id).length === 1) mark(room.sid, member.id);
        },
        left(room, _conn, member) {
          if (!room.hasMember(member.id)) quiet(deps.kv.del(connectedKey(room.sid, member.id)));
        },
      });
      timer = (deps.every ?? defaultEvery)(() => {
        for (const room of deps.rooms.rooms()) {
          for (const member of room.members()) mark(room.sid, member.id);
        }
      }, deps.refreshMs ?? CONNECTED_REFRESH_MS);
    },
    stop() {
      timer?.cancel();
    },
    async isConnected(sid, mid) {
      if (deps.rooms.get(sid)?.hasMember(mid) === true) return true;
      return (await deps.kv.get(connectedKey(sid, mid))) !== null;
    },
    async closeMember(sid, mid, code) {
      const error: ErrorCode | undefined =
        code === CloseCode.Forbidden ? 'not_a_member' : undefined;
      const node = deps.cluster();
      if (node !== undefined) {
        try {
          await node.memberControl.closeMember(mid, {
            code,
            ...(error === undefined ? {} : { error }),
          });
          return;
        } catch {
          // Closed here already (memberControl applies locally first); other nodes' connections
          // fail authorisation on their next frame (the records say so).
          return;
        }
      }
      deps.rooms.get(sid)?.closeMember(mid, code, error);
    },
    async refresh(sid, mid) {
      const live = await deps.membership.refresh(sid, mid);
      const room = deps.rooms.get(sid);
      if (room === undefined || live === null) return;
      if (room.hasMember(mid)) room.setRole(mid, live.role);
    },
  };
}
