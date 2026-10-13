/**
 * The reactions relay module (B062, order 39 = STAGE_ORDER.queue, beside the queue, agents,
 * approvals, branches and locks stages): the reactions stage, and `ctx.reactions` (the read the
 * join flow uses: `reactionsFor(sid, targets)`, the live reactions of those frames per code).
 *
 * - **Stores:** Postgres (`reaction`, `comment_ref`; the relay's client reaches every table).
 * - **Rate limit:** B009's sliding-window limiter on the relay's Redis (200 reactions a minute).
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { reactionStage } from './handler.js';
import {
  createPostgresCommentIndex,
  createPostgresReactionStore,
  type ReactionsDb,
} from './store.js';

const relayModule: RelayModule = {
  name: 'reactions',
  order: STAGE_ORDER.queue,
  register(ctx) {
    const rooms = roomsFor(ctx);
    const db = ctx.db as unknown as ReactionsDb;
    const reactions = createPostgresReactionStore(db);
    const comments = createPostgresCommentIndex(db);
    ctx.pipeline.use(
      STAGE_ORDER.queue,
      reactionStage({
        reactions,
        comments,
        rooms: rooms.registry,
        rateLimit: ctx.redis.rateLimit,
        logger: ctx.log,
        metrics: ctx.metrics,
      }),
    );
    ctx.reactions = {
      reactionsFor: (sid, targets) => reactions.aggregate(sid, targets),
      purge: async (sid) => {
        await reactions.purge(sid);
        await comments.purge(sid);
      },
    };
    return undefined;
  },
};

export default relayModule;
