/**
 * Reaction and comment stores on Postgres (B062, migration 20260102004800_reactions_comments.sql).
 *
 * - **Reactions:** one row per (session, target, code, member) with the seq of the frame that set
 *   it and whether it was removed. A write applies only when its seq is newer than the row's, so
 *   an add twice is one row, a remove drops it from the live set (the row stays as a tombstone at
 *   its seq), a remove of a reaction never added is a no-op, a replay changes nothing, and frames
 *   applied out of order end in the state of the highest seq. Each frame touches only its
 *   sender's row: nobody removes another member's reaction.
 * - **Aggregates:** the live rows of the asked targets, counted per code, in one query.
 * - **Comments:** one pointer per sequenced `comment.add` (seq, frame id, sender, `ct` size, key
 *   id); a frame recorded again changes nothing. No text, no target (both inside `ct`).
 *
 * Owns: the SQL. Must not: store a comment's text, `ct` or target.
 */
import type { createDb, ReactionsDatabase } from '@centcom/db';
import type {
  CommentIndex,
  CommentRef,
  ReactionCode,
  ReactionCounts,
  ReactionOp,
  ReactionStore,
} from './ports.js';

/** The relay's client typed for these tables. */
export type ReactionsDb = ReturnType<typeof createDb<ReactionsDatabase>>;

/** Reactions on Postgres. */
export function createPostgresReactionStore(db: ReactionsDb): ReactionStore {
  const apply = async (sid: string, op: ReactionOp): Promise<{ changed: boolean }> => {
    const removed = op.op === 'remove';
    return db.transaction().execute(async (trx) => {
      // One writer per reaction key at a time (a row lock cannot cover a row not yet there), so
      // `prior` is the state this write replaces, and `changed` holds under concurrent writes.
      await trx
        .selectNoFrom((eb) =>
          eb
            .fn('pg_advisory_xact_lock', [
              eb.fn('hashtext', [eb.val(`reaction:${sid}:${op.target}:${op.code}:${op.from}`)]),
            ])
            .as('locked'),
        )
        .execute();
      const prior = await trx
        .selectFrom('reaction')
        .select(['removed'])
        .where('session_id', '=', sid)
        .where('target', '=', op.target)
        .where('code', '=', op.code)
        .where('member_id', '=', op.from)
        .executeTakeFirst();
      // Insert, or take this frame's state when its seq is newer than the row's.
      const written = await trx
        .insertInto('reaction')
        .values({
          session_id: sid,
          target: op.target,
          code: op.code,
          member_id: op.from,
          seq: op.seq,
          removed,
        })
        .onConflict((oc) =>
          oc
            .columns(['session_id', 'target', 'code', 'member_id'])
            .doUpdateSet((eb) => ({
              seq: eb.ref('excluded.seq'),
              removed: eb.ref('excluded.removed'),
              updated_at: new Date(),
            }))
            .where('reaction.seq', '<', (eb) => eb.ref('excluded.seq')),
        )
        .returning(['seq'])
        .executeTakeFirst();
      if (written === undefined) return { changed: false };
      const wasLive = prior !== undefined && !prior.removed;
      return { changed: wasLive === removed };
    });
  };
  return {
    apply,
    async aggregate(sid, targets) {
      const out: ReactionCounts = {};
      if (targets.length === 0) return out;
      const rows = await db
        .selectFrom('reaction')
        .select(['target', 'code', db.fn.countAll<string>().as('n')])
        .where('session_id', '=', sid)
        .where('target', 'in', [...new Set(targets)])
        .where('removed', '=', false)
        .groupBy(['target', 'code'])
        .execute();
      for (const r of rows) {
        const counts = (out[r.target] ??= {});
        counts[r.code as ReactionCode] = Number(r.n);
      }
      return out;
    },
    async rebuild(sid, ops) {
      let n = 0;
      for await (const op of ops) {
        await apply(sid, op);
        n += 1;
      }
      return n;
    },
    async purge(sid) {
      const r = await db.deleteFrom('reaction').where('session_id', '=', sid).executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  };
}

/** Comment pointers on Postgres. */
export function createPostgresCommentIndex(db: ReactionsDb): CommentIndex {
  return {
    async record(sid, c: CommentRef) {
      await db
        .insertInto('comment_ref')
        .values({
          session_id: sid,
          seq: c.seq,
          msg_id: c.id,
          member_id: c.from,
          size: c.size,
          kid: c.kid,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    },
    async purge(sid) {
      const r = await db.deleteFrom('comment_ref').where('session_id', '=', sid).executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  };
}
