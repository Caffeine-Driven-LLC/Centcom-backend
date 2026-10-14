/**
 * The credential-leak guard on frames (B101 surface 4, order 31 = STAGE_ORDER.secretGuard: right after the
 * privacy gate, which has already cut a frame down to the clear fields its kind may carry): the clear parts
 * of a welcomed connection's frame (`p` and the other plain fields) are scanned for provider credentials.
 * `ct` and `sig` are never read: ciphertext is opaque to the relay. A hit is answered with `sys.error
 * invalid_frame` (the same body for every pattern) and the frame goes no further. The hit is counted and
 * logged by pattern id only, never the text.
 *
 * Owns: the stage. Must not: read `ct` or `sig`, log or echo matched text, or let a frame it could not
 * scan through.
 */
import { newId } from '@centcom/contracts';
import { AppError, secretGuard, toProblem } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER, type InboundStage } from '../pipeline.js';

/** The detail of a refused frame (GUIDELINES section 3.4): the same for every pattern. */
export const SECRET_GUARD_DETAIL = 'The frame was rejected.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stage. */
export function secretGuardStage(
  deps: Parameters<typeof secretGuard.guardFrame>[1] = {},
): InboundStage {
  return async (fc, next) => {
    const frame = fc.frame;
    // Frames of an unwelcomed connection (the hello) are handled by the handshake; nothing else is skipped.
    if (!isRecord(frame) || fc.connection.entry.sessionId === null) {
      await next();
      return;
    }
    const verdict = secretGuard.guardFrame(frame, deps);
    if (verdict.ok) {
      await next();
      return;
    }
    const ref = frame['id'];
    fc.connection.send({
      v: 1,
      t: 'sys.error',
      ...(typeof ref === 'string' ? { ref } : {}),
      p: toProblem(new AppError('invalid_frame', { detail: SECRET_GUARD_DETAIL }), {
        requestId: newId('req'),
      }),
    });
  };
}

const relayModule: RelayModule = {
  name: 'secret-guard',
  order: STAGE_ORDER.secretGuard,
  register(ctx) {
    ctx.pipeline.use(
      STAGE_ORDER.secretGuard,
      secretGuardStage({ metrics: ctx.metrics, logger: ctx.log }),
    );
    return undefined;
  },
};

export default relayModule;
