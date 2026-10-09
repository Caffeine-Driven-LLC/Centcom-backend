/**
 * The privacy gate (B050, order 30: after authorisation, before presence, sequencing and fan-out):
 * a welcomed connection's frames of a catalogued kind keep only the clear fields the catalogue
 * lists (an encrypted kind keeps no `p`); a dropped field is counted
 * (`relay_privacy_violations_total{where="frame"}`) and the frame goes on without it (the field,
 * not the frame, is dropped). A clear `p` over 8 KiB is `sys.error invalid_frame` (pointer `/p`)
 * and goes no further, whatever the kind (but the server-built `queue.state` and `control.roster`).
 * An unknown kind's `p` is carried as it came. Logs carry the kind only.
 *
 * Owns: the stage. Must not: read `ct`, or let a non-listed field of a known kind reach the buffer,
 * the log or another member.
 */
import { newId } from '@centcom/contracts';
import { AppError, noopMetrics, toProblem, type Logger, type Metrics } from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import {
  catalogued,
  clearBytes,
  MAX_CLEAR_BYTES,
  sanitizeClearPayload,
  SERVER_BUILT,
} from './sanitize.js';

/** The detail of a refused frame (GUIDELINES §3.4). */
export const PRIVACY_TOO_LARGE_DETAIL =
  'The frame’s clear payload is larger than the relay carries.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KINDED: ReadonlySet<string> = new Set(['event', 'queue', 'control', 'presence']);

/** The gate. */
export function privacyStage(deps: { logger?: Logger; metrics?: Metrics } = {}): InboundStage {
  const metrics = deps.metrics ?? noopMetrics;
  return async (fc, next) => {
    const frame = fc.frame;
    if (
      !isRecord(frame) ||
      fc.connection.entry.sessionId === null ||
      typeof frame['t'] !== 'string' ||
      !KINDED.has(frame['t']) ||
      typeof frame['k'] !== 'string' ||
      frame['p'] === undefined
    ) {
      await next();
      return;
    }
    const kind = frame['k'];
    if (catalogued(kind) !== undefined) {
      const clean = sanitizeClearPayload(kind, frame['p']);
      if (clean.ok && clean.dropped > 0) {
        metrics.counter('relay_privacy_violations_total', { where: 'frame' }).inc(clean.dropped);
        deps.logger?.debug({ kind }, 'relay.privacy_fields_dropped');
        if (Object.keys(clean.p).length === 0 && catalogued(kind)?.mode === 'encrypted') {
          delete frame['p'];
        } else {
          frame['p'] = clean.p;
        }
      }
    }
    if (
      frame['p'] !== undefined &&
      !SERVER_BUILT.has(kind) &&
      clearBytes(frame['p']) > MAX_CLEAR_BYTES
    ) {
      metrics.counter('relay_privacy_violations_total', { where: 'size' }).inc();
      const ref = frame['id'];
      fc.connection.send({
        v: 1,
        t: 'sys.error',
        ...(typeof ref === 'string' ? { ref } : {}),
        p: toProblem(
          new AppError('invalid_frame', {
            detail: PRIVACY_TOO_LARGE_DETAIL,
            errors: [{ pointer: '/p', code: 'too_large', detail: 'is too large' }],
          }),
          { requestId: newId('req') },
        ),
      });
      return;
    }
    await next();
  };
}
