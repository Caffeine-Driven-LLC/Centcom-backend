/**
 * The agents stage (B057, pipeline order 39 with B052's queue stage: after authorisation (B043:
 * host and editor may send `agent.*`), the privacy gate and the control stage (mutes), right
 * before sequencing). A welcomed member's `agent.spawn`, `agent.state` or `agent.exit` goes to the
 * registry with the rest of the pipeline as its `sequence` step, so the registry records a frame
 * only once it has its `seq`. A refusal goes back to the sender only, as `sys.error` with the
 * frame's id as `ref`; a dropped frame (rate, identical state, exited agent) gets no answer.
 *
 * Owns: routing frames to the registry. Must not: read `ct`, or log a frame.
 */
import { newId } from '@centcom/contracts';
import { AppError, toProblem, type Logger } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../seq/types.js';
import type { AgentFrame, AgentResult } from './ports.js';
import type { AgentRegistry } from './registry.js';

const KINDS = new Set(['agent.spawn', 'agent.state', 'agent.exit']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `registry`. */
export function agentStage(deps: {
  registry: Pick<AgentRegistry, 'onSpawn' | 'onState' | 'onExit'>;
  rooms: Pick<RoomRegistry, 'locate'>;
  logger?: Logger;
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
    const { room, member } = where;
    const agentFrame: AgentFrame = {
      id: frame['id'],
      k: frame['k'] as AgentFrame['k'],
      p: frame['p'],
    };
    const sender = { memberId: member.id, role: member.role };
    let reachedSequencing = false;
    const sequence = async (): Promise<StoredFrame | undefined> => {
      reachedSequencing = true;
      await next();
      return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
    };
    let result: AgentResult;
    try {
      result =
        agentFrame.k === 'agent.spawn'
          ? await deps.registry.onSpawn(room.sid, agentFrame, sender, sequence)
          : agentFrame.k === 'agent.state'
            ? await deps.registry.onState(room.sid, agentFrame, sender, sequence)
            : await deps.registry.onExit(room.sid, agentFrame, sender, sequence);
    } catch (err) {
      // Once the frame went on to sequencing, the later stages answer for it (or fail it).
      if (reachedSequencing) throw err;
      // The store failed or was too busy: the frame was neither recorded nor sequenced.
      deps.logger?.warn(
        { sid: room.sid, kind: agentFrame.k, error: err instanceof Error ? err.name : 'unknown' },
        'agents.frame_failed',
      );
      const error =
        err instanceof AppError
          ? err
          : new AppError('service_unavailable', {
              detail: 'Agents cannot be updated right now; try again shortly.',
              retryAfterS: 1,
            });
      fc.connection.send({
        v: 1,
        t: 'sys.error',
        ref: agentFrame.id,
        p: toProblem(error, { requestId: newId('req') }),
      });
      return;
    }
    if (result.outcome === 'refused') {
      fc.connection.send({
        v: 1,
        t: 'sys.error',
        ref: agentFrame.id,
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
