/**
 * Surface 2b, WebSocket frames (B101): the clear parts are scanned, every frame in
 * contracts/fixtures/events passes, and ciphertext is never read.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../log/logger.js';
import { captureStream, recordingMetrics } from '../../../test/log/helpers.js';
import { guardFrame, stripCiphertext } from '../frame.js';
import { ANTHROPIC_KEY, AWS_KEY, eventFrames } from '../../../test/secret-guard/helpers.js';

describe('guardFrame', () => {
  it('rejects a clear payload that holds a key, with invalid_frame', () => {
    const frame = { v: 1, t: 'event', k: 'sys.error', p: { note: AWS_KEY } };
    expect(guardFrame(frame)).toEqual({
      ok: false,
      code: 'invalid_frame',
      pattern: 'aws_access_key',
    });
  });

  it('accepts every frame of contracts/fixtures/events', () => {
    const frames = eventFrames();
    expect(frames.length).toBeGreaterThanOrEqual(42);
    for (const { name, frame } of frames) expect(guardFrame(frame), name).toEqual({ ok: true });
  });

  it('accepts a frame whose ct is base64url text that happens to contain sk-ant- characters', () => {
    const frame = {
      v: 1,
      t: 'event',
      k: 'message.user',
      ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'AAAA', c: `${ANTHROPIC_KEY}${AWS_KEY}` },
      sig: AWS_KEY,
    };
    expect(guardFrame(frame)).toEqual({ ok: true });
  });

  it('never reads ct or sig (a spy on the property proves it)', () => {
    const reads: string[] = [];
    const frame: Record<string, unknown> = { v: 1, t: 'event', k: 'message.user', p: {} };
    for (const key of ['ct', 'sig']) {
      Object.defineProperty(frame, key, {
        enumerable: true,
        get() {
          reads.push(key);
          return 'x';
        },
      });
    }
    expect(guardFrame(frame)).toEqual({ ok: true });
    expect(Object.keys(stripCiphertext(frame))).toEqual(['v', 't', 'k', 'p']);
    expect(reads).toEqual([]);
  });

  it('fails closed on anything it cannot scan', () => {
    expect(guardFrame(null)).toMatchObject({ ok: false, pattern: 'unscannable' });
    expect(guardFrame([1])).toMatchObject({ ok: false });
    const bad = {
      get p(): string {
        throw new Error('x');
      },
    };
    expect(guardFrame(bad)).toMatchObject({ ok: false, pattern: 'unscannable' });
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(guardFrame({ p: deep })).toMatchObject({ ok: false, pattern: 'unscannable' });
  });

  it('logs and counts only the pattern id, the frame kind and no text', () => {
    const out = captureStream();
    const logger = createLogger({
      level: 'trace',
      service: 'relay',
      version: '1',
      env: 'test',
      destination: out.stream,
    });
    const m = recordingMetrics();
    guardFrame({ k: 'sys.error', p: { note: ANTHROPIC_KEY } }, { logger, metrics: m.metrics });
    const text = out.raw().join('\n');
    expect(text).toContain('"pattern":"anthropic_api_key"');
    expect(text).toContain('"kind":"sys.error"');
    expect(text).not.toContain('sk-ant');
    expect(
      m.count('secret_guard_hits_total', {
        surface: 'frame',
        pattern: 'anthropic_api_key',
      }),
    ).toBe(1);
  });
});
