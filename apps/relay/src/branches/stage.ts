/**
 * The branches stage (B061, pipeline order 39 with the queue, agents, approvals and locks stages:
 * after B043's authorisation and B051's mutes, right before sequencing).
 *
 * - A welcomed member's `branch.update` goes to the branch handler, its `conflict.detected` to the
 *   conflict signal, each with the rest of the pipeline as its `sequence` step. A refusal goes back
 *   to the sender only, as `sys.error` with the frame's id as `ref`.
 * - Every other frame passes untouched: these signals never block anything else.
 *
 * Owns: routing. Must not: read `ct`, or log a frame.
 */
import { newId } from '@centcom/contracts';
import { AppError, toProblem } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import { SEQUENCE_UNKNOWN_KEY, SEQUENCED_STATE_KEY, type StoredFrame } from '../seq/types.js';
import type { BranchHandler } from './branch-handler.js';
import type { ConflictSignal } from './conflict-signal.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over the two handlers. */
export function branchStage(deps: {
  branches: Pick<BranchHandler, 'onBranchUpdate'>;
  conflicts: Pick<ConflictSignal, 'onConflictDetected'>;
  rooms: Pick<RoomRegistry, 'locate'>;
}): InboundStage {
  return async (fc, next) => {
    const frame = fc.frame;
    const kind = isRecord(frame) ? frame['k'] : undefined;
    const where =
      isRecord(frame) &&
      frame['t'] === 'event' &&
      (kind === 'branch.update' || kind === 'conflict.detected')
        ? deps.rooms.locate(fc.connection)
        : undefined;
    if (!isRecord(frame) || where === undefined || typeof frame['id'] !== 'string') {
      await next();
      return;
    }
    const id = frame['id'];
    const ctx = {
      sid: where.room.sid,
      sender: { memberId: where.member.id, role: where.member.role },
      async sequence() {
        await next();
        const stored = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
        if (stored !== undefined) return stored;
        return fc.state[SEQUENCE_UNKNOWN_KEY] === true ? ('unknown' as const) : undefined;
      },
    };
    const routed = { id, p: frame['p'], ct: frame['ct'] };
    const result =
      kind === 'branch.update'
        ? await deps.branches.onBranchUpdate(ctx, routed)
        : await deps.conflicts.onConflictDetected(ctx, routed);
    if (result.outcome === 'refused') {
      fc.connection.send({
        v: 1,
        t: 'sys.error',
        ref: id,
        p: toProblem(
          new AppError(result.code, {
            detail: result.detail,
            ...(result.code === 'service_unavailable' ? { retryAfterS: 1 } : {}),
          }),
          { requestId: newId('req') },
        ),
      });
    }
  };
}
