/**
 * Where presence is kept for every node to read (B047): one Redis hash per session,
 * `presence:{sid}`, one field per member (`{p, at, node}` JSON), the key's TTL 60 s refreshed on
 * every write, so a session nobody updates (a crashed node, an ended session) leaves nothing
 * behind. Reads skip entries older than the TTL, so one member's stale field never shows while
 * others keep the key alive.
 *
 * - `createMemoryPresenceStore`: the same rules in this process (tests, and the fallback).
 * - `createRedisPresenceStore`: on the relay's own Redis connection (B009's backend has no hashes).
 * - `withFallback`: a store that, when Redis fails, uses node-local memory for that call and logs
 *   once (`relay.presence_store_unavailable`); sequenced traffic never depends on it.
 *
 * Owns: the layout and the TTL. Must not: keep a field beyond the payload, its time and the node,
 * or a key without a TTL.
 */
import type { Logger, Metrics } from '@centcom/core';
import { noopMetrics } from '@centcom/core';
import type { Redis } from 'ioredis';
import type { PresenceEntry } from './types.js';

/** A session's presence key lives this long after its last write (card B047). */
export const PRESENCE_TTL_MS = 60_000;

/** Presence of every session, shared by the nodes. */
export interface PresenceStore {
  /** Sets `mid`'s entry and refreshes the session's TTL. */
  write(sid: string, mid: string, entry: PresenceEntry): Promise<void>;
  /** The session's entries no older than the TTL. */
  read(sid: string): Promise<Map<string, PresenceEntry>>;
  /** Removes `mid`'s entry if `node` wrote it (another node may have a newer one). */
  remove(sid: string, mid: string, node: string): Promise<void>;
  /** Forgets the session (it ended). */
  clear(sid: string): Promise<void>;
}

/** The session's key (braces: a Redis Cluster hash tag). */
export const presenceKey = (sid: string): string => `presence:{${sid}}`;

const parseEntry = (json: string): PresenceEntry | null => {
  try {
    const e = JSON.parse(json) as PresenceEntry;
    return typeof e.at === 'number' && typeof e.node === 'string' && typeof e.p === 'object'
      ? e
      : null;
  } catch {
    return null;
  }
};

/** A store in this process, by the Redis store's rules. */
export function createMemoryPresenceStore(clock: () => number = Date.now): PresenceStore & {
  sessions(): number;
} {
  const sessions = new Map<string, { members: Map<string, PresenceEntry>; expiresAt: number }>();
  const live = (sid: string) => {
    const s = sessions.get(sid);
    if (s === undefined) return undefined;
    if (s.expiresAt <= clock()) {
      sessions.delete(sid);
      return undefined;
    }
    return s;
  };
  return {
    write(sid, mid, entry) {
      const s = live(sid) ?? { members: new Map(), expiresAt: 0 };
      s.members.set(mid, entry);
      s.expiresAt = clock() + PRESENCE_TTL_MS;
      sessions.set(sid, s);
      return Promise.resolve();
    },
    read(sid) {
      const now = clock();
      const out = new Map<string, PresenceEntry>();
      for (const [mid, e] of live(sid)?.members ?? []) {
        if (now - e.at <= PRESENCE_TTL_MS) out.set(mid, e);
      }
      return Promise.resolve(out);
    },
    remove(sid, mid, node) {
      const s = live(sid);
      if (s?.members.get(mid)?.node === node) s.members.delete(mid);
      return Promise.resolve();
    },
    clear(sid) {
      sessions.delete(sid);
      return Promise.resolve();
    },
    sessions: () => sessions.size,
  };
}

/** The Redis store, on `client` (an ioredis connection under the environment's key prefix). */
export function createRedisPresenceStore(
  client: Redis,
  clock: () => number = Date.now,
): PresenceStore {
  return {
    async write(sid, mid, entry) {
      const key = presenceKey(sid);
      await client
        .multi()
        .hset(key, mid, JSON.stringify(entry))
        .pexpire(key, PRESENCE_TTL_MS)
        .exec();
    },
    async read(sid) {
      const now = clock();
      const all = await client.hgetall(presenceKey(sid));
      const out = new Map<string, PresenceEntry>();
      for (const [mid, json] of Object.entries(all)) {
        const e = parseEntry(json);
        if (e !== null && now - e.at <= PRESENCE_TTL_MS) out.set(mid, e);
      }
      return out;
    },
    async remove(sid, mid, node) {
      const key = presenceKey(sid);
      const json = await client.hget(key, mid);
      if (json !== null && parseEntry(json)?.node === node) await client.hdel(key, mid);
    },
    async clear(sid) {
      await client.del(presenceKey(sid));
    },
  };
}

/** `primary`, with node-local memory for any call it fails (logged once). */
export function withFallback(
  primary: PresenceStore,
  local: PresenceStore,
  deps: { logger?: Logger; metrics?: Metrics } = {},
): PresenceStore {
  const metrics = deps.metrics ?? noopMetrics;
  let warned = false;
  const fallback = <T>(run: (s: PresenceStore) => Promise<T>): Promise<T> =>
    run(primary).catch((err: unknown) => {
      metrics.counter('relay_presence_store_failed_total').inc();
      if (!warned) {
        warned = true;
        deps.logger?.warn(
          { error: err instanceof Error ? err.name : typeof err },
          'relay.presence_store_unavailable',
        );
      }
      return run(local);
    });
  return {
    write: (sid, mid, entry) =>
      // Kept locally too, so a later fallback read has it.
      local.write(sid, mid, entry).then(() => fallback((s) => s.write(sid, mid, entry))),
    read: (sid) => fallback((s) => s.read(sid)),
    remove: (sid, mid, node) =>
      local.remove(sid, mid, node).then(() => fallback((s) => s.remove(sid, mid, node))),
    clear: (sid) => local.clear(sid).then(() => fallback((s) => s.clear(sid))),
  };
}
