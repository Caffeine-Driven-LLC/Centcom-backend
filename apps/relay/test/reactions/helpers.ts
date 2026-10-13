/**
 * Test helpers for reactions and comments (B062): frames from
 * `contracts/fixtures/events/reaction.json` and `comment.add.json` with fresh ids; the stage over
 * recording stores and B009's in-memory rate limiter, with a sequencer that numbers frames and
 * de-duplicates by `(from, id)` as B041 does; and a Postgres 16 stack (B010's: DATABASE_URL, or a
 * container runtime) with a live session to write into.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { createFactories } from '@centcom/testkit';
import { reactionStage } from '../../src/reactions/handler.js';
import type { CommentRef, ReactionOp } from '../../src/reactions/ports.js';
import {
  createPostgresCommentIndex,
  createPostgresReactionStore,
  type ReactionsDb,
} from '../../src/reactions/store.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import type { TestStack } from '../slots/helpers.js';

/** A fixture frame as a client sends it (no server `from`, `ts` or `seq`), with a fresh id. */
function clientFixture(kind: 'reaction' | 'comment.add'): Record<string, unknown> {
  const url = new URL(`../../../../contracts/fixtures/events/${kind}.json`, import.meta.url);
  const frame = (JSON.parse(readFileSync(url, 'utf8')) as { frame: Record<string, unknown> }).frame;
  return {
    ...Object.fromEntries(
      Object.entries(frame).filter(([key]) => !['seq', 'from', 'ts'].includes(key)),
    ),
    id: newId('msg'),
  };
}

/** A `reaction` frame. */
export function reaction(
  target: string,
  code: string = 'thumbs',
  op: 'add' | 'remove' = 'add',
): Record<string, unknown> {
  return { ...clientFixture('reaction'), p: { target, code, op } };
}

/** A `comment.add` frame (fixture `ct`). */
export function comment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...clientFixture('comment.add'), ...over };
}

/** The stage over recording stores. */
export function stageEnv(opts: { limiterDown?: boolean } = {}) {
  const clock = { now: Date.parse('2026-10-11T12:00:00.000Z') };
  const redis = createMemoryRedis(() => clock.now);
  const applied: { sid: string; op: ReactionOp }[] = [];
  const recorded: { sid: string; c: CommentRef }[] = [];
  const fail = { on: false };
  const captured = captureLogger();
  const metrics = recordingMetrics();
  const sid = newId('ses');
  const stage = reactionStage({
    reactions: {
      apply(s, op) {
        if (fail.on) return Promise.reject(new Error('db down'));
        applied.push({ sid: s, op });
        return Promise.resolve({ changed: true });
      },
      aggregate: () => Promise.resolve({}),
      rebuild: () => Promise.resolve(0),
      purge: () => Promise.resolve(0),
    },
    comments: {
      record(s, c) {
        if (fail.on) return Promise.reject(new Error('db down'));
        recorded.push({ sid: s, c });
        return Promise.resolve();
      },
      purge: () => Promise.resolve(0),
    },
    rooms: {
      locate: (conn) =>
        ({
          room: { sid },
          member: { id: (conn as unknown as { member: string }).member, sid },
        }) as never,
    },
    rateLimit:
      opts.limiterDown === true
        ? { consume: () => Promise.reject(new Error('redis down')) }
        : redis.rateLimit,
    logger: captured.logger,
    metrics: metrics.metrics,
  });
  const seen = new Map<string, number>();
  let head = 0;
  const member = () => newId('mem');
  /** Runs `frame` through the stage as `from`. */
  const send = async (frame: Record<string, unknown>, from: string) => {
    const sent: Record<string, unknown>[] = [];
    let passed = false;
    const fc: FrameContext = {
      connection: {
        member: from,
        send: (f: Record<string, unknown>) => (sent.push(f), true),
      } as unknown as RelayConnection,
      raw: null,
      frame,
      state: {},
    };
    await stage(fc, () => {
      passed = true;
      const key = `${from}:${String(frame['id'])}`;
      if (!seen.has(key)) {
        head += 1;
        seen.set(key, head);
        fc.state[SEQUENCED_STATE_KEY] = { ...frame, seq: head } as unknown as StoredFrame;
      }
      return Promise.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));
    return { sent, passed, error: sent.find((f) => f['t'] === 'sys.error') };
  };
  return { clock, sid, fail, applied, recorded, captured, metrics, member, send };
}

/** A live session on the stack, and the stores over it. */
export async function pgEnv(stack: TestStack) {
  const f = createFactories(stack.db);
  const session = await f.sessions.create({ state: 'live' });
  const db = stack.db as unknown as ReactionsDb;
  return {
    db,
    sid: session.id,
    reactions: createPostgresReactionStore(db),
    comments: createPostgresCommentIndex(db),
  };
}
