/**
 * The presence stage (B047, order 35: after authorisation, before sequencing): takes a welcomed
 * connection's `presence.update`, checks `p` (`invalid_frame` with the field's pointer, state
 * unchanged), keeps only `status`, `activity` and `agent_count`, and hands it to the service under
 * the connection's member (a client's `from` is never read). The frame goes no further: presence is
 * never sequenced. Other presence kinds (`presence.cursor`, `presence.nudge`) and everything else
 * pass on.
 *
 * Owns: the stage. Must not: read anything in the frame but `t`, `k`, `id` and `p`.
 */
import { newId } from '@centcom/contracts';
import { AppError, noopMetrics, toProblem, type Metrics } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import { PRESENCE_UPDATE, type PresenceService } from './types.js';
import { checkPresenceUpdate } from './validate.js';

/** The detail of a refused update (GUIDELINES §3.4). */
export const PRESENCE_INVALID_DETAIL =
  'presence.update needs status and activity from the catalogue.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `service`. */
export function presenceStage(deps: {
  service: Pick<PresenceService, 'update'>;
  clock?: () => number;
  metrics?: Metrics;
}): InboundStage {
  const clock = deps.clock ?? Date.now;
  const metrics = deps.metrics ?? noopMetrics;
  return async (fc, next) => {
    const frame = fc.frame;
    if (!isRecord(frame) || frame['t'] !== 'presence' || frame['k'] !== PRESENCE_UPDATE) {
      await next();
      return;
    }
    const { entry } = fc.connection;
    if (entry.sessionId === null || entry.memberId === null) return;
    const checked = checkPresenceUpdate(frame['p']);
    if (!checked.ok) {
      metrics.counter('relay_presence_updates_total', { result: 'invalid' }).inc();
      const ref = frame['id'];
      fc.connection.send({
        v: 1,
        t: 'sys.error',
        ...(typeof ref === 'string' ? { ref } : {}),
        p: toProblem(
          new AppError('invalid_frame', {
            detail: PRESENCE_INVALID_DETAIL,
            errors: [{ pointer: checked.pointer, code: 'invalid', detail: 'is not allowed' }],
          }),
          { requestId: newId('req') },
        ),
      });
      return;
    }
    deps.service.update(entry.sessionId, entry.memberId, checked.value, clock());
  };
}
