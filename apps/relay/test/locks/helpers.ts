/**
 * Test helpers for file locks (B059): the service over the Redis store on B009's in-memory Redis
 * (every key and value written is recorded, for the privacy scan), a fake clock, a recording
 * emitter for server frames, and a sequencer that numbers client frames and their companions the
 * way B041 does (a resend keeps its seq, companions in the same batch).
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { createMemoryRedis, type KeyValue } from '@centcom/core';
import type { FileLockFrameIn, LockSender } from '../../src/locks/ports.js';
import { LockService, type LockServiceDeps } from '../../src/locks/service.js';
import { createRedisLockStore } from '../../src/locks/store.js';
import type { StoredFrame, UnsequencedFrame } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

/** The contract fixture of `file.lock`. */
export function fixture(): Record<string, unknown> {
  const url = new URL('../../../../contracts/fixtures/events/file.lock.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { frame: Record<string, unknown> }).frame;
}

/** A `file.lock` frame from a client. */
export function lock(
  action: string,
  path: string,
  agent: string,
  ttl?: number,
): FileLockFrameIn & { p: Record<string, unknown> } {
  return {
    id: newId('msg'),
    p: { action, path_hmac: path, agent_id: agent, ...(ttl === undefined ? {} : { ttl_ms: ttl }) },
  };
}

/** A lock environment. */
export function lockEnv(overrides: Partial<LockServiceDeps> = {}) {
  const clock = { now: Date.parse('2026-10-10T12:00:00.000Z') };
  const redis = createMemoryRedis(() => clock.now);
  const written: { key: string; value: string }[] = [];
  const down = { on: false };
  const kv: Pick<KeyValue, 'get' | 'set' | 'setIfAbsent' | 'del'> = {
    get: (k) => (down.on ? Promise.reject(new Error('redis down')) : redis.kv.get(k)),
    set: (k, v, o) => {
      if (down.on) return Promise.reject(new Error('redis down'));
      written.push({ key: k, value: v });
      return redis.kv.set(k, v, o);
    },
    setIfAbsent: (k, v, ttl) => {
      if (down.on) return Promise.reject(new Error('redis down'));
      written.push({ key: k, value: v });
      return redis.kv.setIfAbsent(k, v, ttl);
    },
    del: (k) => (down.on ? Promise.reject(new Error('redis down')) : redis.kv.del(k)),
  };
  const emitted: { sid: string; p: Record<string, unknown> }[] = [];
  const sequenced: { frame: Record<string, unknown>; from: string; seq: number }[] = [];
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const hints: { pathHmac: string; holder: string; requester: string }[] = [];
  const service = new LockService({
    store: createRedisLockStore({ kv, clock: () => clock.now }),
    emitter: {
      emit(sid, frames) {
        for (const p of frames) emitted.push({ sid, p });
        return Promise.resolve();
      },
    },
    hints: { denied: (_sid, h) => void hints.push(h) },
    clock: () => clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
    ...overrides,
  });
  const seen = new Map<string, number>();
  let head = 0;
  const sid = newId('ses');
  const host: LockSender = { memberId: newId('mem'), role: 'host' };
  const editor: LockSender = { memberId: newId('mem'), role: 'editor' };
  const other: LockSender = { memberId: newId('mem'), role: 'editor' };
  /** Sends `frame` from `by` through the service, sequencing as B041 would. */
  const send = (frame: FileLockFrameIn, by: LockSender) =>
    service.handle(
      {
        sid,
        sender: by,
        sequence(companions: UnsequencedFrame[]) {
          const key = `${by.memberId}:${frame.id}`;
          const prior = seen.get(key);
          const seq = prior ?? ++head;
          if (prior === undefined) {
            seen.set(key, seq);
            sequenced.push({ frame: { k: 'file.lock', ...frame }, from: by.memberId, seq });
            for (const c of companions) {
              head += 1;
              sequenced.push({
                frame: c as unknown as Record<string, unknown>,
                from: 'srv',
                seq: head,
              });
            }
          }
          return Promise.resolve({ seq, ts: new Date(clock.now).toISOString() } as StoredFrame);
        },
      },
      frame,
    );
  /** The `p` of every server and client frame sequenced or emitted, in order of kind. */
  const serverFrames = () => [
    ...sequenced
      .filter((s) => s.from === 'srv')
      .map((s) => s.frame['p'] as Record<string, unknown>),
    ...emitted.map((e) => e.p),
  ];
  return {
    clock,
    redis,
    kv,
    down,
    written,
    emitted,
    sequenced,
    captured,
    recorded,
    hints,
    service,
    sid,
    host,
    editor,
    other,
    send,
    serverFrames,
  };
}
