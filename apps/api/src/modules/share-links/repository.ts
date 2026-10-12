/**
 * The share-link store (B068): links (by token hash only), their guests, and what a join needs to
 * know about the session. `createPostgresShareLinkStore` keeps them in Postgres
 * (`share_link`, `guest_member`); tests use an in-memory store with the same rules.
 *
 * - **consume** is the join's one transaction: `uses = uses + 1 WHERE uses < max_uses AND not
 *   revoked AND not expired`, the guest's row, then the caller's step (signing the ticket). A link
 *   used up by concurrent joins matches no row; a step that throws rolls everything back, so no
 *   use is spent without a ticket.
 * - **revoke** marks the link revoked and deletes its guests in one transaction, and returns their
 *   member ids (to close their connections).
 * - **sweep** deletes the guests of expired links and of sessions that are over.
 *
 * Owns: the SQL. Must not: see or store a token in plain (only hashes come in), or decide who may
 * act (the service does).
 */
import type { createDb, SessionsLifecycleDatabase, ShareLinkTables } from '@centcom/db';
import type { SessionState } from '../sessions/state-machine.js';

/** The API's client over the tables share links read and write. */
export type ShareLinkDb = ReturnType<typeof createDb<SessionsLifecycleDatabase & ShareLinkTables>>;

/** A stored link. */
export interface ShareLinkRecord {
  id: string;
  sessionId: string;
  tokenHash: Buffer;
  expiresAt: Date;
  maxUses: number;
  uses: number;
  revokedAt: Date | null;
  createdByMember: string;
  createdAt: Date;
}

/** What a join needs of the session. */
export interface JoinSession {
  id: string;
  workspaceId: string | null;
  state: SessionState;
  region: string;
  /** The policy's `locked` (B051): a locked session takes no new members. */
  locked: boolean;
}

/** A guest to write. */
export interface NewGuest {
  memberId: string;
  sessionId: string;
  name: string;
  slot: number;
}

/** Where links live. */
export interface ShareLinkStore {
  create(link: Omit<ShareLinkRecord, 'id' | 'uses' | 'revokedAt'>): Promise<ShareLinkRecord>;
  /** The link whose token hashes to `hash`, or null. */
  findByHash(hash: Buffer): Promise<ShareLinkRecord | null>;
  session(sessionId: string): Promise<JoinSession | null>;
  /** Live members of the session: its session_members rows not left, and its guests. */
  countMembers(sessionId: string): Promise<number>;
  /**
   * Spends one use of link `linkId` (if it can still be used at `now`), writes `guest`, and runs
   * `step`, in one transaction; `{ok: false}` when the link could not be used (nothing written).
   * A `step` that throws rolls it all back and rethrows.
   */
  consume<T>(
    linkId: string,
    now: Date,
    guest: NewGuest,
    step: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }>;
  /** Gives back a slot B031 assigned for a guest that was not written. */
  releaseSlot(sessionId: string, memberId: string): Promise<void>;
  /**
   * Revokes the session's link whose token hashes to `hash` and deletes its guests; null when the
   * session has no such link. A link already revoked is returned again (no guests left).
   */
  revoke(
    sessionId: string,
    hash: Buffer,
    at: Date,
  ): Promise<{ link: ShareLinkRecord; guests: string[] } | null>;
  /** Deletes the guests of links expired at `now` and of sessions that are over; by session. */
  sweep(now: Date): Promise<{ sessionId: string; memberIds: string[] }[]>;
}

type LinkRow = {
  id: string;
  session_id: string;
  token_hash: Buffer;
  expires_at: Date;
  max_uses: number;
  uses: number;
  revoked_at: Date | null;
  created_by_member: string;
  created_at: Date;
};

const toRecord = (r: LinkRow): ShareLinkRecord => ({
  id: r.id,
  sessionId: r.session_id,
  tokenHash: r.token_hash,
  expiresAt: r.expires_at,
  maxUses: r.max_uses,
  uses: r.uses,
  revokedAt: r.revoked_at,
  createdByMember: r.created_by_member,
  createdAt: r.created_at,
});

/** Thrown inside the join's transaction when the link cannot be used. */
class Unusable extends Error {}

/** The store on Postgres. */
export function createPostgresShareLinkStore(db: ShareLinkDb): ShareLinkStore {
  return {
    async create(link) {
      const row = await db
        .insertInto('share_link')
        .values({
          session_id: link.sessionId,
          token_hash: link.tokenHash,
          expires_at: link.expiresAt,
          max_uses: link.maxUses,
          created_by_member: link.createdByMember,
          created_at: link.createdAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    },

    async findByHash(hash) {
      const row = await db
        .selectFrom('share_link')
        .selectAll()
        .where('token_hash', '=', hash)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async session(sessionId) {
      const row = await db
        .selectFrom('sessions')
        .leftJoin('session_policy', 'session_policy.session_id', 'sessions.id')
        .select([
          'sessions.id',
          'sessions.workspace_id',
          'sessions.state',
          'sessions.region',
          'session_policy.locked',
        ])
        .where('sessions.id', '=', sessionId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        state: row.state,
        region: row.region,
        locked: row.locked ?? false,
      };
    },

    async countMembers(sessionId) {
      const [members, guests] = await Promise.all([
        db
          .selectFrom('session_members')
          .select(db.fn.countAll<string>().as('n'))
          .where('session_id', '=', sessionId)
          .where('left_at', 'is', null)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('guest_member')
          .select(db.fn.countAll<string>().as('n'))
          .where('session_id', '=', sessionId)
          .executeTakeFirstOrThrow(),
      ]);
      return Number(members.n) + Number(guests.n);
    },

    async consume(linkId, now, guest, step) {
      try {
        const value = await db.transaction().execute(async (trx) => {
          const used = await trx
            .updateTable('share_link')
            .set((eb) => ({ uses: eb('uses', '+', 1) }))
            .where('id', '=', linkId)
            .where('revoked_at', 'is', null)
            .where('expires_at', '>', now)
            .whereRef('uses', '<', 'max_uses')
            .returning('id')
            .executeTakeFirst();
          if (used === undefined) throw new Unusable();
          await trx
            .insertInto('guest_member')
            .values({
              member_id: guest.memberId,
              session_id: guest.sessionId,
              share_link_id: linkId,
              name: guest.name,
              slot: guest.slot,
              created_at: now,
            })
            .execute();
          return step();
        });
        return { ok: true, value };
      } catch (err) {
        if (err instanceof Unusable) return { ok: false };
        throw err;
      }
    },

    async releaseSlot(sessionId, memberId) {
      await db
        .deleteFrom('session_member_slots')
        .where('session_id', '=', sessionId)
        .where('member_id', '=', memberId)
        .execute();
    },

    async revoke(sessionId, hash, at) {
      return db.transaction().execute(async (trx) => {
        const found = await trx
          .selectFrom('share_link')
          .selectAll()
          .where('session_id', '=', sessionId)
          .where('token_hash', '=', hash)
          .forUpdate()
          .executeTakeFirst();
        if (found === undefined) return null;
        const link =
          found.revoked_at === null
            ? await trx
                .updateTable('share_link')
                .set({ revoked_at: at })
                .where('id', '=', found.id)
                .returningAll()
                .executeTakeFirstOrThrow()
            : found;
        const guests = await trx
          .deleteFrom('guest_member')
          .where('share_link_id', '=', found.id)
          .returning('member_id')
          .execute();
        return { link: toRecord(link), guests: guests.map((g) => g.member_id) };
      });
    },

    async sweep(now) {
      const gone = await db
        .deleteFrom('guest_member')
        .where((eb) =>
          eb.or([
            eb(
              'share_link_id',
              'in',
              eb.selectFrom('share_link').select('id').where('expires_at', '<=', now),
            ),
            eb(
              'session_id',
              'in',
              eb.selectFrom('sessions').select('id').where('state', 'in', ['ended', 'expired']),
            ),
          ]),
        )
        .returning(['session_id', 'member_id'])
        .execute();
      const bySession = new Map<string, string[]>();
      for (const g of gone) {
        const list = bySession.get(g.session_id) ?? [];
        list.push(g.member_id);
        bySession.set(g.session_id, list);
      }
      return [...bySession].map(([sessionId, memberIds]) => ({ sessionId, memberIds }));
    },
  };
}
