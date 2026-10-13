/**
 * The board module (B111, pipeline order 39 beside the agents, locks and queue stages: after
 * authorisation and mutes, right before sequencing). Sets `ctx.board`.
 */
import { roomsFor } from '../rooms/runtime.js';
import { STAGE_ORDER } from '../pipeline.js';
import type { RelayModule } from '../modules.js';
import { BoardService, createRedisBoardStore } from './service.js';
import { boardStage } from './stage.js';

const relayModule: RelayModule = {
  name: 'board',
  order: STAGE_ORDER.queue,
  register(ctx) {
    const rooms = roomsFor(ctx);
    const board = new BoardService({
      store: createRedisBoardStore({ kv: ctx.redis.kv, clock: ctx.clock }),
      rateLimit: ctx.redis.rateLimit,
      clock: ctx.clock,
      metrics: ctx.metrics,
    });
    ctx.pipeline.use(STAGE_ORDER.queue, boardStage({ board, rooms: rooms.registry }));
    ctx.board = board;
    return undefined;
  },
};

export default relayModule;
