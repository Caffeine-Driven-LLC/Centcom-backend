/**
 * The reactions stage (B062, pipeline order 39 with the queue, agents, approvals, branches and
 * locks stages: after B043's authorisation, which lets host, editor and viewer send both kinds
 * and refuses a muted member's frames with `muted`, and right before sequencing).
 *
 * - **`reaction`** (cleartext): `p.target` a frame id (`msg_`), `p.code` one of the contract's six
 *   codes, `p.op` add or remove, else `invalid_frame` (B039's codec refuses them first); at most
 *   200 per member per minute (B009's sliding window), else `rate_limited`.
 * - **`comment.add`** (encrypted: its target and text are in `ct`): a `p`, or a missing `ct`, is
 *   `invalid_frame` (the codec again first, with `ct` at most 192 KiB).
 * - **After sequencing** (sequenced frames only, so replaying the log reproduces the state): the
 *   reaction is applied to the per-target set for its sender, the comment's pointer (seq, frame id,
 *   sender, `ct` size, key id) recorded. In the background: delivery never waits for Postgres. A
 *   failed write is counted and logged; the frame stays in the log, and `ReactionStore.rebuild`
 *   replays it.
 * - Every other frame passes untouched.
 *
 * Owns: routing and the checks. Must not: read, store or log `ct` (a comment's text or target).
 */
import { newId, validateEvent } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  toProblem,
  type Logger,
  type Metrics,
  type RateLimitStore,
} from '@centcom/core';
import type { InboundStage } from '../pipeline.js';
import type { RoomRegistry } from '../rooms/registry.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../seq/types.js';
import {
  REACTION_CODES,
  REACTION_OPS_PER_MINUTE,
  TARGET,
  type CommentIndex,
  type ReactionCode,
  type ReactionStore,
} from './ports.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const CODES: ReadonlySet<string> = new Set(REACTION_CODES);

/** What the stage needs. */
export interface ReactionStageDeps {
  reactions: ReactionStore;
  comments: CommentIndex;
  rooms: Pick<RoomRegistry, 'locate'>;
  rateLimit: Pick<RateLimitStore, 'consume'>;
  logger?: Logger;
  metrics?: Metrics;
}

/** The stage. */
export function reactionStage(deps: ReactionStageDeps): InboundStage {
  const metrics = deps.metrics ?? noopMetrics;
  const failed = (sid: string, kind: string) => (err: unknown) => {
    metrics.counter('relay_reaction_writes_failed_total', { kind }).inc();
    deps.logger?.warn(
      { sid, kind, error: err instanceof Error ? err.name : 'unknown' },
      'reactions.write_failed',
    );
  };
  return async (fc, next) => {
    const frame = fc.frame;
    const kind = isRecord(frame) ? frame['k'] : undefined;
    const where =
      isRecord(frame) &&
      frame['t'] === 'event' &&
      (kind === 'reaction' || kind === 'comment.add') &&
      typeof frame['id'] === 'string'
        ? deps.rooms.locate(fc.connection)
        : undefined;
    if (!isRecord(frame) || where === undefined) {
      await next();
      return;
    }
    const sid = where.room.sid;
    const member = where.member.id;
    const id = frame['id'] as string;
    const refuse = (code: 'invalid_frame' | 'rate_limited', detail: string, retryAfterS?: number) =>
      fc.connection.send({
        v: 1,
        t: 'sys.error',
        ref: id,
        p: toProblem(
          new AppError(code, {
            detail,
            ...(retryAfterS === undefined ? {} : { retryAfterS }),
          }),
          { requestId: newId('req') },
        ),
      });
    const p = frame['p'];
    if (kind === 'reaction') {
      if (
        !validateEvent('reaction', p, { mode: 'tolerant' }).ok ||
        !isRecord(p) ||
        typeof p['target'] !== 'string' ||
        !TARGET.test(p['target']) ||
        typeof p['code'] !== 'string' ||
        !CODES.has(p['code']) ||
        (p['op'] !== 'add' && p['op'] !== 'remove')
      ) {
        refuse(
          'invalid_frame',
          'A reaction names a frame (msg_), one of the six codes, and add or remove.',
        );
        return;
      }
      let allowed: boolean;
      let resetS = 1;
      try {
        const r = await deps.rateLimit.consume(
          `reaction-ops:${sid}:${member}`,
          REACTION_OPS_PER_MINUTE,
          60,
        );
        allowed = r.allowed;
        resetS = r.resetS;
      } catch {
        // The limiter is down: reactions are cheap and idempotent, let them through.
        allowed = true;
      }
      if (!allowed) {
        refuse('rate_limited', 'At most 200 reactions a minute.', resetS);
        return;
      }
      await next();
      const stored = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
      if (stored === undefined) return;
      deps.reactions
        .apply(sid, {
          seq: stored.seq,
          from: member,
          target: p['target'],
          code: p['code'] as ReactionCode,
          op: p['op'],
        })
        .catch(failed(sid, 'reaction'));
      return;
    }
    // comment.add: encrypted only.
    const ct = frame['ct'];
    if (p !== undefined || !isRecord(ct) || typeof ct['kid'] !== 'string') {
      refuse('invalid_frame', 'comment.add carries ct only.');
      return;
    }
    await next();
    const stored = fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
    if (stored === undefined) return;
    deps.comments
      .record(sid, {
        seq: stored.seq,
        id,
        from: member,
        size: Buffer.byteLength(JSON.stringify(ct), 'utf8'),
        kid: ct['kid'],
      })
      .catch(failed(sid, 'comment'));
  };
}
