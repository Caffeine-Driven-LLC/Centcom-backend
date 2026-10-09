/**
 * The cursor stage (B048, order 36, after presence): takes a welcomed connection's
 * `presence.cursor` and offers it to the throttle under the connection's member (a client's `from`
 * is never read). A `ct` over the size cap is `sys.error invalid_frame` (pointer `/ct`) and the
 * connection stays; a cursor over the rate is dropped silently. Either way the frame goes no
 * further: cursors are never sequenced. Everything else passes on.
 *
 * Owns: the stage. Must not: read `ct` (only its serialised size, in the throttle).
 */
import { newId } from '@centcom/contracts';
import { AppError, toProblem } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import { PRESENCE_CURSOR, type CursorThrottle } from './throttle.js';

/** The detail of a refused cursor (GUIDELINES §3.4). */
export const CURSOR_TOO_LARGE_DETAIL = 'A cursor frame’s ct is larger than the relay accepts.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage over `throttle`. */
export function cursorStage(deps: {
  throttle: CursorThrottle;
  clock?: () => number;
}): InboundStage {
  const clock = deps.clock ?? Date.now;
  return async (fc, next) => {
    const frame = fc.frame;
    if (!isRecord(frame) || frame['t'] !== 'presence' || frame['k'] !== PRESENCE_CURSOR) {
      await next();
      return;
    }
    const { entry } = fc.connection;
    if (entry.sessionId === null || entry.memberId === null) return;
    const sig = frame['sig'];
    const result = deps.throttle.offer(
      entry.sessionId,
      entry.memberId,
      { ct: frame['ct'], ...(typeof sig === 'string' ? { sig } : {}) },
      clock(),
    );
    if (result !== 'dropped_size') return;
    const ref = frame['id'];
    fc.connection.send({
      v: 1,
      t: 'sys.error',
      ...(typeof ref === 'string' ? { ref } : {}),
      p: toProblem(
        new AppError('invalid_frame', {
          detail: CURSOR_TOO_LARGE_DETAIL,
          errors: [{ pointer: '/ct', code: 'too_large', detail: 'is too large' }],
        }),
        { requestId: newId('req') },
      ),
    });
  };
}
