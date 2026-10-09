/**
 * The keys stages (B049):
 *
 * - **Validation** (order 25, after authorisation, before sequencing), for a welcomed connection's
 *   sequenced frames:
 *   - a `key.grant` must pass `validateKeyGrant` (role, `to_device`, `kids`) and name a device of a
 *     current member of the session; otherwise `sys.error` (`forbidden` or `invalid_frame` with
 *     the field's pointer) and the frame is not sequenced;
 *   - any frame with a `ct` has its `ct.kid` checked against the session's epoch (`check`):
 *     invalid, future, or stale (older, and the connection acked the rotation that superseded it)
 *     is `invalid_frame` at `/ct/kid`, not sequenced. In-flight frames stay valid until the ack.
 *   The epoch store or the device lookup unavailable: `service_unavailable` (`retry_after_s` 1),
 *   connection kept: fail closed, never unchecked.
 * - **Rotation** (order 41, after sequencing): a `control.rotate_request` B041 just sequenced (a
 *   resend of the same id is a duplicate and never gets here) makes the relay emit one
 *   `control.rotate_key` for the next epoch, after the request itself is delivered. B043 already
 *   lets only a host send it, and refuses a client's `control.rotate_key`.
 *
 * Only `p.to_device`, `p.kids`, `p.reason` and `ct.kid` are read. Logs carry sessions and outcomes.
 *
 * Owns: the stages. Must not: read `ct` beyond `kid`, or let a frame through unchecked.
 */
import { newId } from '@centcom/contracts';
import { AppError, noopMetrics, toProblem, type Logger, type Metrics } from '@centcom/core';
import type { InboundStage, RelayConnection } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import {
  SEQUENCED_STATE_KEY,
  SEQUENCED_TYPES,
  SERVER_FROM,
  type AckTracker,
  type StoredFrame,
} from '../seq/types.js';
import type { SessionDevices } from './devices.js';
import type { createEpochs, KidCheck } from './epochs.js';
import { validateKeyGrant } from './validate.js';

/** The details of the stage's refusals (GUIDELINES §3.4). */
export const KEYS_DETAILS = Object.freeze({
  grant: 'The key grant does not route to a device of this session.',
  grantRole: 'Only a host or an editor may grant keys.',
  kid: {
    invalid: 'ct.kid must be k followed by the epoch number.',
    future: 'ct.kid is newer than the session’s current key epoch.',
    stale: 'ct.kid is from a key epoch you already acknowledged a rotation of.',
  } satisfies Record<Exclude<KidCheck, 'ok'>, string>,
  unavailable: 'Keys cannot be checked right now; send the frame again shortly.',
} as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Epochs = ReturnType<typeof createEpochs>;

function sysError(conn: RelayConnection, error: AppError, ref: unknown): void {
  conn.send({
    v: 1,
    t: 'sys.error',
    ...(typeof ref === 'string' ? { ref } : {}),
    p: toProblem(error, { requestId: newId('req') }),
  });
}

const invalid = (detail: string, pointer: string): AppError =>
  new AppError('invalid_frame', {
    detail,
    errors: [{ pointer, code: 'invalid', detail: 'is not allowed' }],
  });

/** The validation stage (order 25). */
export function keysStage(deps: {
  epochs: Pick<Epochs, 'state' | 'check'>;
  devices: SessionDevices;
  rooms: Pick<RoomRegistry, 'locate'>;
  /** B041's ack tracker (its module registers later). */
  acks: () => Pick<AckTracker, 'acked'> | undefined;
  metrics?: Metrics;
}): InboundStage {
  const metrics = deps.metrics ?? noopMetrics;
  const counted = (name: string, labels: Record<string, string>): void =>
    metrics.counter(name, labels).inc();
  return async (fc, next) => {
    const frame = fc.frame;
    const conn = fc.connection;
    const { entry } = conn;
    if (
      !isRecord(frame) ||
      entry.sessionId === null ||
      entry.memberId === null ||
      typeof frame['t'] !== 'string' ||
      !SEQUENCED_TYPES.has(frame['t'])
    ) {
      await next();
      return;
    }
    const sid = entry.sessionId;
    const ref = frame['id'];
    try {
      if (frame['k'] === 'key.grant') {
        const role = deps.rooms.locate(conn)?.member.role ?? 'viewer';
        const check = validateKeyGrant(frame, {
          role,
          epoch: (await deps.epochs.state(sid)).current,
        });
        if (!check.ok) {
          counted('relay_key_grants_total', { result: check.error });
          sysError(
            conn,
            check.error === 'forbidden'
              ? new AppError('forbidden', { detail: KEYS_DETAILS.grantRole })
              : invalid(KEYS_DETAILS.grant, check.pointer ?? '/p'),
            ref,
          );
          return;
        }
        if (!(await deps.devices.isMemberDevice(sid, check.toDevice))) {
          counted('relay_key_grants_total', { result: 'invalid_frame' });
          sysError(conn, invalid(KEYS_DETAILS.grant, '/p/to_device'), ref);
          return;
        }
        counted('relay_key_grants_total', { result: 'routed' });
      }
      const ct = frame['ct'];
      if (isRecord(ct)) {
        const verdict = await deps.epochs.check(sid, ct['kid'], deps.acks()?.acked(entry.id) ?? 0);
        if (verdict !== 'ok') {
          counted('relay_kid_refused_total', { reason: verdict });
          sysError(conn, invalid(KEYS_DETAILS.kid[verdict], '/ct/kid'), ref);
          return;
        }
      }
    } catch {
      counted('relay_key_checks_unavailable_total', {});
      sysError(
        conn,
        new AppError('service_unavailable', { detail: KEYS_DETAILS.unavailable, retryAfterS: 1 }),
        ref,
      );
      return;
    }
    await next();
  };
}

/** The rotation stage (order 41, after sequencing). */
export function rotateStage(deps: {
  epochs: Pick<Epochs, 'rotate'>;
  logger?: Logger;
  metrics?: Metrics;
}): InboundStage {
  const metrics = deps.metrics ?? noopMetrics;
  return async (fc, next) => {
    const stored = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
    await next();
    if (
      stored === undefined ||
      stored.t !== 'control' ||
      stored.k !== 'control.rotate_request' ||
      stored.from === SERVER_FROM
    ) {
      return;
    }
    const p = (stored as { p?: unknown }).p;
    const asked = isRecord(p) ? p['reason'] : undefined;
    const reason = asked === 'scheduled' ? 'scheduled' : 'requested';
    try {
      await deps.epochs.rotate(stored.sid, reason);
    } catch (err) {
      metrics.counter('relay_epoch_rotate_failed_total').inc();
      deps.logger?.warn(
        { sid: stored.sid, error: err instanceof Error ? err.name : typeof err },
        'relay.key_rotation_failed',
      );
      sysError(
        fc.connection,
        new AppError('service_unavailable', { detail: KEYS_DETAILS.unavailable, retryAfterS: 1 }),
        stored.id,
      );
    }
  };
}
