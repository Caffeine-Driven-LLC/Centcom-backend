/**
 * The approvals stage (B060, pipeline order 39 with the queue, agents and locks stages: after
 * B043's authorisation (host and editor may send both kinds; viewers never get here) and B051's
 * mutes, right before sequencing).
 *
 * - A welcomed member's `approval.request` / `approval.decision` goes to the router with the rest
 *   of the pipeline as its `sequence` step. A refusal goes back to the sender only, as `sys.error`
 *   with the frame's id as `ref`.
 * - Once an `agent.exit` is sequenced, the agent's pending approvals are dropped; once a
 *   `control.kick` or `control.mute` is, those the member requested (in the background: the frame
 *   is not held). No deny is sent for them.
 * - Every other frame passes untouched.
 *
 * Owns: routing. Must not: read `ct`, or log a frame.
 */
import { isId, newId } from '@centcom/contracts';
import { AppError, toProblem, type Logger } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import {
  SEQUENCE_UNKNOWN_KEY,
  SEQUENCED_DUPLICATE_KEY,
  SEQUENCED_STATE_KEY,
  type StoredFrame,
} from '../seq/types.js';
import type { ApprovalRouter } from './router.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `router`. */
export function approvalStage(deps: {
  router: Pick<ApprovalRouter, 'onRequest' | 'onDecision' | 'cancelForAgent' | 'cancelForMember'>;
  rooms: Pick<RoomRegistry, 'locate'>;
  logger?: Logger;
}): InboundStage {
  const cleanup = (sid: string, run: () => Promise<number>): void => {
    run().catch((err: unknown) =>
      deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'approvals.cleanup_failed',
      ),
    );
  };
  return async (fc, next) => {
    const frame = fc.frame;
    const where = isRecord(frame) ? deps.rooms.locate(fc.connection) : undefined;
    if (!isRecord(frame) || where === undefined || typeof frame['id'] !== 'string') {
      await next();
      return;
    }
    const sid = where.room.sid;
    const kind = frame['k'];
    if (frame['t'] === 'event' && (kind === 'approval.request' || kind === 'approval.decision')) {
      const id = frame['id'];
      const ctx = {
        sid,
        sender: { memberId: where.member.id, role: where.member.role },
        async sequence() {
          await next();
          const stored = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
          if (stored !== undefined) return { frame: stored, duplicate: false };
          const again = fc.state[SEQUENCED_DUPLICATE_KEY] as StoredFrame | undefined;
          if (again !== undefined) return { frame: again, duplicate: true };
          return fc.state[SEQUENCE_UNKNOWN_KEY] === true ? 'unknown' : undefined;
        },
      };
      const routed = { id, p: frame['p'] };
      const result =
        kind === 'approval.request'
          ? await deps.router.onRequest(ctx, routed)
          : await deps.router.onDecision(ctx, routed);
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
      return;
    }
    await next();
    if (fc.state[SEQUENCED_STATE_KEY] === undefined) return;
    const p = frame['p'];
    if (kind === 'agent.exit' && isRecord(p) && isId('agt', p['agent_id'])) {
      const agent = p['agent_id'] as string;
      cleanup(sid, () => deps.router.cancelForAgent(sid, agent));
    } else if (
      (kind === 'control.kick' || kind === 'control.mute') &&
      isRecord(p) &&
      isId('mem', p['member'])
    ) {
      const member = p['member'] as string;
      cleanup(sid, () => deps.router.cancelForMember(sid, member));
    }
  };
}
