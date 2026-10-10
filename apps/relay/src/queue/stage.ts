/**
 * The queue stage (B052, pipeline order 39 = STAGE_ORDER.queue: after authorisation, the privacy
 * gate and the control stage, right before sequencing). A welcomed member's `queue.*` frame (not
 * `queue.state`, which B043 already refuses from clients) goes to the queue service, with the rest
 * of the pipeline as its `sequence` step: an auto-approval rides along as a companion frame
 * (`COMPANION_FRAMES_KEY`) so B041 sequences both in one batch. A refusal, or the notice of a
 * reorder that named unknown items, goes back to the sender only with the frame's id as `ref`.
 *
 * Owns: routing frames to the service. Must not: read `ct`.
 */
import type { Problem } from '@centcom/core';
import type { InboundStage, RelayConnection } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import {
  COMPANION_FRAMES_KEY,
  SEQUENCED_COMPANIONS_KEY,
  SEQUENCED_STATE_KEY,
  type StoredFrame,
} from '../seq/types.js';
import type { QueueService } from './service.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sendError = (conn: RelayConnection, problem: Problem, ref: string): void => {
  conn.send({ v: 1, t: 'sys.error', ref, p: problem });
};

/** The stage over `service`. */
export function queueStage(deps: {
  service: Pick<QueueService, 'handle'>;
  rooms: Pick<RoomRegistry, 'locate'>;
}): InboundStage {
  return async (fc, next) => {
    const frame = fc.frame;
    if (
      !isRecord(frame) ||
      frame['t'] !== 'queue' ||
      typeof frame['k'] !== 'string' ||
      frame['k'] === 'queue.state' ||
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
    const { room, member } = where;
    const id = frame['id'];
    const outcome = await deps.service.handle(
      {
        sid: room.sid,
        sender: {
          id: member.id,
          role: member.role,
          userId: member.userId,
          workspaceId: member.workspaceId,
        },
        connection: fc.connection,
        async sequence(companions) {
          if (companions.length > 0) fc.state[COMPANION_FRAMES_KEY] = companions;
          await next();
          const stored = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
          if (stored === undefined) return undefined;
          return {
            frame: stored,
            companions: (fc.state[SEQUENCED_COMPANIONS_KEY] as StoredFrame[] | undefined) ?? [],
          };
        },
      },
      { t: 'queue', id, k: frame['k'], p: frame['p'] },
    );
    if (!outcome.accepted && outcome.error !== undefined)
      sendError(fc.connection, outcome.error, id);
    if (outcome.accepted && outcome.notice !== undefined)
      sendError(fc.connection, outcome.notice, id);
  };
}
