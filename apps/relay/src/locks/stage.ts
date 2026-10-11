/**
 * The locks stage (B059, pipeline order 39 with B052's queue and B057's agents stages: after
 * B043's authorisation (host and editor may send `file.lock`) and B051's mutes, right before
 * sequencing).
 *
 * - A welcomed member's `file.lock` goes to the service with the rest of the pipeline as its
 *   `sequence` step (companions, the grants of a release, ride in the same batch). A refusal goes
 *   back to the sender only, as `sys.error` with the frame's id as `ref`.
 * - Once an `agent.exit` is sequenced, the agent's locks are freed; once a `control.kick` is, the
 *   kicked member's; once a `control.end` is, the session's (in the background: the frame is not
 *   held).
 * - Every other frame passes untouched: locks are advisory and never block a non-lock frame.
 *
 * Owns: routing. Must not: read `ct`, or log a frame.
 */
import { isId, newId } from '@centcom/contracts';
import { AppError, toProblem, type Logger } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import {
  COMPANION_FRAMES_KEY,
  SEQUENCED_STATE_KEY,
  type StoredFrame,
  type UnsequencedFrame,
} from '../seq/types.js';
import type { LockService } from './service.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `service`. */
export function lockStage(deps: {
  service: Pick<
    LockService,
    'handle' | 'releaseAllForAgent' | 'releaseAllForMember' | 'releaseAll'
  >;
  rooms: Pick<RoomRegistry, 'locate'>;
  logger?: Logger;
}): InboundStage {
  const cleanup = (sid: string, run: () => Promise<number>): void => {
    run().catch((err: unknown) =>
      deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'locks.cleanup_failed',
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
    if (frame['t'] === 'event' && kind === 'file.lock') {
      const id = frame['id'];
      const outcome = await deps.service.handle(
        {
          sid,
          sender: { memberId: where.member.id, role: where.member.role },
          async sequence(companions: UnsequencedFrame[]) {
            if (companions.length > 0) fc.state[COMPANION_FRAMES_KEY] = companions;
            await next();
            return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
          },
        },
        { id, p: frame['p'] },
      );
      if (outcome.outcome === 'refused') {
        fc.connection.send({
          v: 1,
          t: 'sys.error',
          ref: id,
          p: toProblem(
            new AppError(outcome.code, {
              detail: outcome.detail,
              ...(outcome.code === 'service_unavailable' ? { retryAfterS: 1 } : {}),
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
      cleanup(sid, () => deps.service.releaseAllForAgent(sid, agent));
    } else if (kind === 'control.kick' && isRecord(p) && isId('mem', p['member'])) {
      const member = p['member'] as string;
      cleanup(sid, () => deps.service.releaseAllForMember(sid, member));
    } else if (kind === 'control.end') {
      cleanup(sid, () => deps.service.releaseAll(sid));
    }
  };
}
