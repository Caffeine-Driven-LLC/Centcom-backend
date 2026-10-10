/**
 * Mutes (B051, CT-WS-CONTROL `control.mute` / `control.unmute`): who the host silenced, until when.
 * B043's authorise stage asks `isMuted` for every `event` and `queue` frame and refuses a muted
 * member's with `sys.error muted`; `presence` and `control` frames are never muted.
 *
 * - **Store** (`MuteStore`): `session_mute` in Postgres, so a mute holds on every node and across
 *   restarts. `until` null is a mute until unmuted.
 * - **Cache:** `isMuted` must answer synchronously, so each session's mutes are kept in memory and
 *   read again when they are more than `ttlMs` (2 s) old. `ready(sid)` is what the authorise stage
 *   waits on: nothing when the session's mutes are fresh, else the (shared) reload.
 *   - A reload that fails, for a session read before: the old mutes stay in use and the next
 *     frame after `ttlMs` tries again (logged and counted).
 *   - A session never read: `ready` rejects, and the stage refuses the frame with
 *     `service_unavailable` (fail closed).
 * - **This node's changes** (`mute`, `unmute`) are written to the store, then to the cache at once;
 *   other nodes see them within `ttlMs`.
 * - **Expiry:** a mute whose `until` has passed is no mute (the injected clock decides). Its row
 *   stays until the member is muted or unmuted again.
 *
 * Owns: mute state. Must not: decide which frames a mute silences (B043's `authorizeFrame`).
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { MuteState } from '../rooms/kind-policy.js';
import type { ControlDb } from './policy-store.js';

/** A session's mutes are read again after this long. */
export const MUTE_CACHE_TTL_MS = 2_000;
/** Sessions cached at most (oldest out first). */
export const MUTE_CACHE_MAX_SESSIONS = 100_000;

/** A muted member: until when (ms since the epoch), or null until unmuted. */
export interface Mute {
  member: string;
  until: number | null;
}

/** Where mutes are kept. */
export interface MuteStore {
  list(sid: string): Promise<Mute[]>;
  put(sid: string, mid: string, until: number | null): Promise<void>;
  remove(sid: string, mid: string): Promise<void>;
}

/** The mute state B043 reads, and the writes `control.mute` / `unmute` make. */
export interface MuteRegistry extends MuteState {
  /** True while `mid` is muted in `sid` at `now` (default: the clock). */
  isMuted(sid: string, mid: string, now?: number): boolean;
  /** Undefined when `sid`'s mutes are fresh; else resolves once they are read. */
  ready(sid: string): Promise<void> | undefined;
  mute(sid: string, mid: string, until: number | null): Promise<void>;
  unmute(sid: string, mid: string): Promise<void>;
  /** Forgets a session (it ended). */
  forget(sid: string): void;
}

/** Options for `createMuteRegistry`. */
export interface MuteRegistryDeps {
  store: MuteStore;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  ttlMs?: number;
  maxSessions?: number;
  logger?: Logger;
  metrics?: Metrics;
}

interface Entry {
  /** When read from the store. */
  at: number;
  /** False for an entry made by a local change before any read. */
  loaded: boolean;
  mutes: Map<string, number | null>;
}

/** The registry over `store`. */
export function createMuteRegistry(deps: MuteRegistryDeps): MuteRegistry {
  const clock = deps.clock ?? Date.now;
  const ttl = deps.ttlMs ?? MUTE_CACHE_TTL_MS;
  const max = deps.maxSessions ?? MUTE_CACHE_MAX_SESSIONS;
  const metrics = deps.metrics ?? noopMetrics;
  const sessions = new Map<string, Entry>();
  const loading = new Map<string, Promise<void>>();

  function put(sid: string, entry: Entry): void {
    sessions.delete(sid);
    sessions.set(sid, entry);
    while (sessions.size > max) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  function load(sid: string): Promise<void> {
    const running = loading.get(sid);
    if (running !== undefined) return running;
    const started = clock();
    const task = deps.store.list(sid).then(
      (list) => {
        loading.delete(sid);
        put(sid, {
          at: started,
          loaded: true,
          mutes: new Map(list.map((m) => [m.member, m.until])),
        });
      },
      (err: unknown) => {
        loading.delete(sid);
        metrics.counter('relay_control_mute_loads_failed_total').inc();
        deps.logger?.warn(
          { sid, error: err instanceof Error ? err.name : typeof err },
          'relay.mute_load_failed',
        );
        const known = sessions.get(sid);
        // Read before: keep those mutes, and try again after the TTL.
        if (known?.loaded === true) {
          known.at = clock();
          return;
        }
        throw err;
      },
    );
    loading.set(sid, task);
    return task;
  }

  return {
    isMuted(sid, mid, now = clock()) {
      const until = sessions.get(sid)?.mutes.get(mid);
      if (until === undefined) return false;
      return until === null || until > now;
    },
    ready(sid) {
      const entry = sessions.get(sid);
      if (entry?.loaded === true && clock() - entry.at < ttl) return undefined;
      return load(sid);
    },
    async mute(sid, mid, until) {
      await deps.store.put(sid, mid, until);
      const entry = sessions.get(sid);
      if (entry === undefined)
        put(sid, { at: clock(), loaded: false, mutes: new Map([[mid, until]]) });
      else entry.mutes.set(mid, until);
    },
    async unmute(sid, mid) {
      await deps.store.remove(sid, mid);
      sessions.get(sid)?.mutes.delete(mid);
    },
    forget(sid) {
      sessions.delete(sid);
    },
  };
}

/** Mutes in memory (tests). */
export function createMemoryMuteStore(): MuteStore & { failing: boolean; rows(): Mute[] } {
  const rows = new Map<string, Map<string, number | null>>();
  const store = {
    failing: false,
    rows: () =>
      [...rows.values()].flatMap((m) => [...m].map(([member, until]) => ({ member, until }))),
    list(sid: string): Promise<Mute[]> {
      if (store.failing) return Promise.reject(new Error('mute store down'));
      return Promise.resolve(
        [...(rows.get(sid) ?? new Map<string, number | null>())].map(([member, until]) => ({
          member,
          until,
        })),
      );
    },
    put(sid: string, mid: string, until: number | null): Promise<void> {
      if (store.failing) return Promise.reject(new Error('mute store down'));
      const session = rows.get(sid) ?? new Map<string, number | null>();
      session.set(mid, until);
      rows.set(sid, session);
      return Promise.resolve();
    },
    remove(sid: string, mid: string): Promise<void> {
      if (store.failing) return Promise.reject(new Error('mute store down'));
      rows.get(sid)?.delete(mid);
      return Promise.resolve();
    },
  };
  return store;
}

/** Mutes in Postgres (`session_mute`). */
export function createPostgresMuteStore(db: ControlDb): MuteStore {
  return {
    async list(sid) {
      const rows = await db
        .selectFrom('session_mute')
        .select(['member_id', 'until'])
        .where('session_id', '=', sid)
        .execute();
      return rows.map((r) => ({
        member: r.member_id,
        until: r.until === null ? null : r.until.getTime(),
      }));
    },
    async put(sid, mid, until) {
      const at = until === null ? null : new Date(until);
      await db
        .insertInto('session_mute')
        .values({ session_id: sid, member_id: mid, until: at })
        .onConflict((oc) =>
          oc
            .columns(['session_id', 'member_id'])
            .doUpdateSet({ until: at, updated_at: new Date() }),
        )
        .execute();
    },
    async remove(sid, mid) {
      await db
        .deleteFrom('session_mute')
        .where('session_id', '=', sid)
        .where('member_id', '=', mid)
        .execute();
    },
  };
}
