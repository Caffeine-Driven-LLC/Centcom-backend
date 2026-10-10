/**
 * The control stage (B051, pipeline order 38 = STAGE_ORDER.control: after authorisation and the
 * privacy gate, right before sequencing).
 *
 * - A welcomed connection's frame on a session that ended through this node: closed 4404
 *   (`session_ended`), nothing sequenced.
 * - A client control kind (`control.kick` ... `control.policy`): handed to the handler with the
 *   rest of the pipeline as its `sequence` step, so the handler checks before and applies after
 *   the frame's `seq`. A refusal goes back to the sender only, with the frame's id as `ref`.
 * - Everything else passes on untouched.
 *
 * Owns: routing frames to the handler. Must not: read a frame's payload (the handler does).
 */
import { CloseCode } from '../close-codes.js';
import { closeConnection } from '../connection/close.js';
import type { InboundStage } from '../pipeline.js';
import { MEMBER_FRAME_TYPES } from '../rooms/kind-policy.js';
import type { RoomRegistry } from '../rooms/registry.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../seq/types.js';
import { isClientControlKind } from './authority.js';
import { sendControlError, type ControlFrameIn, type ControlHandler } from './handler.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `handler`. */
export function controlStage(deps: {
  handler: Pick<ControlHandler, 'handleControlFrame' | 'hasEnded'>;
  rooms: Pick<RoomRegistry, 'locate'>;
}): InboundStage {
  return async (fc, next) => {
    const frame = fc.frame;
    if (!isRecord(frame) || typeof frame['t'] !== 'string' || !MEMBER_FRAME_TYPES.has(frame['t'])) {
      await next();
      return;
    }
    const where = deps.rooms.locate(fc.connection);
    if (where === undefined) {
      await next();
      return;
    }
    const { room, member } = where;
    if (deps.handler.hasEnded(room.sid)) {
      closeConnection(fc.connection, { code: CloseCode.NotFound, errorCode: 'session_ended' });
      return;
    }
    if (frame['t'] !== 'control' || !isClientControlKind(frame['k'])) {
      await next();
      return;
    }
    const id = frame['id'];
    if (typeof id !== 'string') {
      // B041 refuses a frame without an id.
      await next();
      return;
    }
    const outcome = await deps.handler.handleControlFrame(
      {
        sid: room.sid,
        sender: { id: member.id, userId: member.userId, workspaceId: member.workspaceId },
        async sequence() {
          await next();
          return (fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined)?.seq;
        },
      },
      { t: 'control', id, sid: room.sid, k: frame['k'], p: frame['p'] } as ControlFrameIn,
    );
    if (!outcome.accepted && outcome.error !== undefined) {
      sendControlError(fc.connection, outcome.error, id);
    }
  };
}
