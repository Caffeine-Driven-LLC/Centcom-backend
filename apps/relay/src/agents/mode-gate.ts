/**
 * The command-post gate (B110): the catalogue marks most work kinds `host, editor*`, and the note
 * says "in command-post mode only the host emits; in branch mode the agent's owner emits for their
 * own agents". B043 lets host and editor send them (it cannot know the mode), so this stage closes
 * the command-post half: in a `command_post` session an editor's `message.*`, `tool.*`,
 * `approval.request`, `diff.share`, `file.lock` or `agent.handoff` is refused `forbidden`, not
 * sequenced. (`agent.*` is B057's, `branch.update` and `conflict.detected` are B061's; both check
 * the mode themselves.)
 *
 * What stays with the clients in a `branch` session: the relay cannot see which agent an encrypted
 * `message.*`, `tool.*` or `diff.share` frame is about (the `agent_id` is inside `ct`), so it cannot
 * check that the sender owns that agent. A receiving client must: accept a frame about an agent only
 * from the agent's owner (the `agent.spawn` the relay already verified names the owner) or the host.
 *
 * Fails closed: if the mode cannot be read the frame is answered `service_unavailable`.
 *
 * Owns: this refusal. Must not: read `p` or `ct`, or log a frame.
 */
import { newId } from '@centcom/contracts';
import { AppError, toProblem, type Logger } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import type { SessionModePort } from './ports.js';

/** The `editor*` kinds this stage gates (see the header for the ones other stages gate). */
export const HOST_ONLY_IN_COMMAND_POST: ReadonlySet<string> = new Set([
  'message.user',
  'message.assistant.delta',
  'message.assistant.done',
  'message.system',
  'tool.request',
  'tool.result',
  'approval.request',
  'diff.share',
  'file.lock',
  'agent.handoff',
]);

export const MODE_GATE_DETAILS = Object.freeze({
  hostOnly: 'Only the host sends this in a command-post session.',
  unavailable: 'The relay cannot read the session mode right now; try again shortly.',
  notOwner: "Only the host or the agent's owner may offer an agent to someone else.",
} as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `modes`. */
export function commandPostGate(deps: {
  modes: SessionModePort;
  rooms: Pick<RoomRegistry, 'locate'>;
  /** Who owns an agent: with it, an `agent.handoff` offer must come from the agent's owner (or the host). */
  owners?: { ownerOf(sid: string, agentId: string): Promise<string | undefined> };
  logger?: Logger;
}): InboundStage {
  return async (fc, next) => {
    const frame = fc.frame;
    if (
      !isRecord(frame) ||
      frame['t'] !== 'event' ||
      typeof frame['k'] !== 'string' ||
      !HOST_ONLY_IN_COMMAND_POST.has(frame['k'])
    ) {
      await next();
      return;
    }
    const where = deps.rooms.locate(fc.connection);
    if (where === undefined || where.member.role === 'host') {
      await next();
      return;
    }
    let refusal: AppError | undefined;
    try {
      if ((await deps.modes.modeOf(where.room.sid)) === 'command_post') {
        refusal = new AppError('forbidden', { detail: MODE_GATE_DETAILS.hostOnly });
      } else if (frame['k'] === 'agent.handoff' && deps.owners !== undefined) {
        const p = frame['p'];
        if (isRecord(p) && p['op'] === 'offer' && typeof p['agent_id'] === 'string') {
          const owner = await deps.owners.ownerOf(where.room.sid, p['agent_id']);
          if (owner !== where.member.id) {
            refusal = new AppError('forbidden', { detail: MODE_GATE_DETAILS.notOwner });
          }
        }
      }
    } catch (err) {
      deps.logger?.warn(
        { sid: where.room.sid, error: err instanceof Error ? err.name : 'unknown' },
        'agents.mode_unreadable',
      );
      refusal = new AppError('service_unavailable', {
        detail: MODE_GATE_DETAILS.unavailable,
        retryAfterS: 1,
      });
    }
    if (refusal === undefined) {
      await next();
      return;
    }
    fc.connection.send({
      v: 1,
      t: 'sys.error',
      ...(typeof frame['id'] === 'string' ? { ref: frame['id'] } : {}),
      p: toProblem(refusal, { requestId: newId('req') }),
    });
  };
}
