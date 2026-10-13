/**
 * The board stage (B111): routes a welcomed member's `board.note`, `board.pin` and `board.remove`
 * to the board service with the rest of the pipeline as its sequencing step; a refusal goes back to
 * the sender only, as `sys.error` with the frame's id as `ref`. Every other frame passes untouched.
 *
 * Owns: routing. Must not: read `ct`, or log a frame.
 */
import { newId } from '@centcom/contracts';
import { AppError, toProblem } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../seq/types.js';
import type { BoardFrame, BoardService } from './service.js';

const KINDS = new Set(['board.note', 'board.pin', 'board.remove']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `board`. */
export function boardStage(deps: {
  board: Pick<BoardService, 'handle'>;
  rooms: Pick<RoomRegistry, 'locate'>;
}): InboundStage {
  return async (fc, next) => {
    const frame = fc.frame;
    if (
      !isRecord(frame) ||
      frame['t'] !== 'event' ||
      typeof frame['k'] !== 'string' ||
      !KINDS.has(frame['k']) ||
      typeof frame['id'] !== 'string'
    ) {
      await next();
      return;
    }
    const where = deps.rooms.locate(fc.connection);
    if (where === undefined) {
      await next();
      return;
    }
    const routed: BoardFrame = { id: frame['id'], k: frame['k'] as BoardFrame['k'], p: frame['p'] };
    const result = await deps.board.handle(
      where.room.sid,
      { memberId: where.member.id, role: where.member.role },
      routed,
      async (): Promise<StoredFrame | undefined> => {
        await next();
        return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
      },
    );
    if (result.outcome === 'refused') {
      fc.connection.send({
        v: 1,
        t: 'sys.error',
        ref: frame['id'],
        p: toProblem(
          new AppError(result.code, {
            detail: result.detail,
            ...(result.code === 'service_unavailable' || result.code === 'frame_rate_exceeded'
              ? { retryAfterS: result.code === 'service_unavailable' ? 1 : 60 }
              : {}),
          }),
          { requestId: newId('req') },
        ),
      });
    }
  };
}
