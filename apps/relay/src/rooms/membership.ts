/**
 * Live membership (B043, CT-RBAC rules 1-3): the member's role as the records say now, never as
 * the ticket or a frame claims.
 *
 * - **Source** (`createPostgresMembership`): the session member's row (`session_members`: still
 *   in, not left) and, for a session in a workspace, the user's workspace membership in a live
 *   workspace. The live role is the session role, capped by the workspace role as CT-RBAC's matrix
 *   says: a `guest` joins as `viewer` at most, and `billing` may not be in a session at all. Null
 *   means "no longer a member".
 * - **Cache** (`LiveMembership`): answers are reused for at most `ttlMs` (2 s, CT-RBAC rule 2);
 *   concurrent misses for one member share one read; a failed read is not cached (the caller fails
 *   closed). `invalidateUser` drops a user's entries when a membership event arrives, so the next
 *   frame reads the records again. At most `maxEntries` entries, oldest out first.
 *
 * Owns: reading and caching live roles. Must not: trust a ticket's or a frame's role, or cache a
 * failure.
 */
import type { RelayDb } from '../modules.js';
import type { SessionRole } from './kind-policy.js';

/** CT-RBAC rule 2: a role is re-read at least this often. */
export const MEMBERSHIP_CACHE_TTL_MS = 2_000;
/** Members cached at most. */
export const MEMBERSHIP_CACHE_MAX_ENTRIES = 100_000;

/** A member as the live records have them. */
export interface LiveMember {
  role: SessionRole;
  userId: string;
  /** The session's workspace; null for a session outside any workspace. */
  workspaceId: string | null;
}

/** Where live membership is read. */
export interface MembershipSource {
  /** Member `memberId` of session `sid` now; null when they are no longer a member. */
  lookup(sid: string, memberId: string): Promise<LiveMember | null>;
}

/** The session role a workspace role allows at most; null when it allows no session at all. */
export function capRole(
  sessionRole: SessionRole,
  workspaceRole: string | null,
): SessionRole | null {
  if (workspaceRole === 'billing') return null;
  if (workspaceRole === 'guest') return 'viewer';
  return sessionRole;
}

/** Live membership in Postgres. */
export function createPostgresMembership(db: RelayDb): MembershipSource {
  return {
    async lookup(sid, memberId) {
      const row = await db
        .selectFrom('session_members as sm')
        .innerJoin('sessions as s', 's.id', 'sm.session_id')
        .leftJoin('workspaces as w', 'w.id', 's.workspace_id')
        .leftJoin('memberships as m', (join) =>
          join.onRef('m.workspace_id', '=', 's.workspace_id').onRef('m.user_id', '=', 'sm.user_id'),
        )
        .select([
          'sm.role',
          'sm.user_id',
          'sm.left_at',
          's.workspace_id',
          'w.deleted_at as workspace_deleted_at',
          'm.role as workspace_role',
        ])
        .where('sm.id', '=', memberId)
        .where('sm.session_id', '=', sid)
        .executeTakeFirst();
      if (row === undefined || row.left_at !== null) return null;
      if (row.workspace_id !== null) {
        // The user must still be a member of a live workspace.
        if (row.workspace_role === null || row.workspace_deleted_at !== null) return null;
      }
      const role = capRole(row.role, row.workspace_role);
      if (role === null) return null;
      return { role, userId: row.user_id, workspaceId: row.workspace_id };
    },
  };
}

/** Options for LiveMembership. */
export interface LiveMembershipOptions {
  source: MembershipSource;
  /** Default MEMBERSHIP_CACHE_TTL_MS (at most 2 000). */
  ttlMs?: number;
  /** Default MEMBERSHIP_CACHE_MAX_ENTRIES. */
  maxEntries?: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

interface Entry {
  value: LiveMember | null;
  at: number;
}

/** A read-through cache of live membership, at most 2 s old. */
export class LiveMembership {
  readonly #source: MembershipSource;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #clock: () => number;
  readonly #entries = new Map<string, Entry>();
  /** Reads running, with the generation they started in. */
  readonly #loading = new Map<string, { generation: number; load: Promise<LiveMember | null> }>();
  /** Bumped by every invalidation, so a read that started before one is not cached. */
  #generation = 0;

  constructor(options: LiveMembershipOptions) {
    const ttl = options.ttlMs ?? MEMBERSHIP_CACHE_TTL_MS;
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > MEMBERSHIP_CACHE_TTL_MS) {
      throw new TypeError('LiveMembership: ttlMs must be an integer from 0 to 2000');
    }
    this.#source = options.source;
    this.#ttlMs = ttl;
    this.#maxEntries = options.maxEntries ?? MEMBERSHIP_CACHE_MAX_ENTRIES;
    this.#clock = options.clock ?? Date.now;
  }

  /** The member now: from the cache when at most `ttlMs` old, else read. */
  get(sid: string, memberId: string): Promise<LiveMember | null> {
    const key = `${sid}:${memberId}`;
    const entry = this.#entries.get(key);
    if (entry !== undefined && this.#clock() - entry.at < this.#ttlMs) {
      return Promise.resolve(entry.value);
    }
    return this.refresh(sid, memberId);
  }

  /**
   * Reads the member from the records now and caches it. A read already running is shared only
   * if it started after the last invalidation: one from before a membership event may predate the
   * change, so a new read starts instead.
   */
  refresh(sid: string, memberId: string): Promise<LiveMember | null> {
    const key = `${sid}:${memberId}`;
    const generation = this.#generation;
    const running = this.#loading.get(key);
    if (running !== undefined && running.generation === generation) return running.load;
    const load = this.#source.lookup(sid, memberId).then(
      (value) => {
        if (this.#loading.get(key)?.load === load) this.#loading.delete(key);
        if (generation === this.#generation) this.#store(key, value);
        return value;
      },
      (err: unknown) => {
        if (this.#loading.get(key)?.load === load) this.#loading.delete(key);
        throw err;
      },
    );
    this.#loading.set(key, { generation, load });
    return load;
  }

  #store(key: string, value: LiveMember | null): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, at: this.#clock() });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Drops every cached entry of `userId` (a membership event): the next read goes to the records. */
  invalidateUser(userId: string): void {
    this.#generation += 1;
    for (const [key, entry] of this.#entries) {
      if (entry.value === null || entry.value.userId === userId) this.#entries.delete(key);
    }
  }

  /** Entries cached. */
  get size(): number {
    return this.#entries.size;
  }
}
