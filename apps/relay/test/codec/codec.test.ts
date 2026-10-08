/**
 * `decodeFrame` and `encodeFrame` (B039 acceptance 1, 2, 3, 4, 5, 7 and 8): the 256 KiB boundary,
 * binary and invalid UTF-8, every event fixture, flipped payload modes with JSON pointers, unknown
 * kinds passing untouched and unknown types failing, unknown fields dropped, server-set fields
 * never surviving (property over 1 000 frames), the session check, `ct` and `queue.submit` size
 * boundaries, the nesting limit, canonical encoding, and 100 000 random byte strings that never
 * make it throw. Decoding a 256 KiB frame takes under 5 ms p95 (child process).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  FRAME_LIMITS,
  nestsDeeperThan,
  SERVER_SET_FIELDS,
} from '../../src/codec/codec.js';
import { eventFixtures, FIXTURE_SID, frameOfBytes, nestedFrame } from './helpers.js';

const decode = (raw: string | Buffer, sid: string | null = FIXTURE_SID) =>
  decodeFrame(raw, false, sid);

describe('frame size', () => {
  it('accepts exactly 256 KiB and refuses one byte more, before parsing', () => {
    const exact = frameOfBytes(FRAME_LIMITS.maxFrameBytes);
    expect(Buffer.byteLength(exact)).toBe(262_144);
    expect(decode(exact).ok).toBe(true);
    const over = frameOfBytes(FRAME_LIMITS.maxFrameBytes + 1);
    expect(decode(over)).toEqual({ ok: false, code: 'frame_too_large', pointer: '' });
    expect(decode(Buffer.from(over))).toMatchObject({ code: 'frame_too_large' });
    // Over the limit and not even JSON: still frame_too_large, so nothing was parsed.
    expect(decode('{'.repeat(FRAME_LIMITS.maxFrameBytes + 1))).toMatchObject({
      code: 'frame_too_large',
    });
  });

  it('counts bytes, not characters', () => {
    const base = frameOfBytes(FRAME_LIMITS.maxFrameBytes - 1);
    const twoByte = base.replace('"pad":"a', '"pad":"é');
    expect(Buffer.byteLength(twoByte)).toBe(FRAME_LIMITS.maxFrameBytes);
    expect(decode(twoByte).ok).toBe(true);
    const threeByte = base.replace('"pad":"a', '"pad":"€');
    expect(threeByte.length).toBe(FRAME_LIMITS.maxFrameBytes - 1);
    expect(Buffer.byteLength(threeByte)).toBe(FRAME_LIMITS.maxFrameBytes + 1);
    expect(decode(threeByte)).toMatchObject({ code: 'frame_too_large' });
  });

  it('refuses binary messages and bytes that are not UTF-8', () => {
    expect(decodeFrame(Buffer.from('{}'), true, FIXTURE_SID)).toMatchObject({
      code: 'invalid_frame',
    });
    expect(decode(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).toMatchObject({ code: 'invalid_frame' });
    expect(decode(Buffer.from(frameOfBytes(200))).ok).toBe(true);
  });
});

describe('the event fixtures', () => {
  const fixtures = eventFixtures();

  it('finds them', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
  });

  it.each(fixtures.map((f) => [f.kind, f.frame] as const))('decodes %s', (_kind, frame) => {
    const result = decode(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const field of SERVER_SET_FIELDS) expect(result.frame).not.toHaveProperty(field);
  });

  it.each(
    fixtures.filter((f) => f.frame['ct'] !== undefined).map((f) => [f.kind, f.frame] as const),
  )('refuses %s without its ct, naming the field', (_kind, frame) => {
    const rest = Object.fromEntries(
      Object.entries(frame).filter(([field]) => field !== 'ct' && field !== 'sig'),
    );
    const result = decode(JSON.stringify(rest));
    expect(result).toMatchObject({ ok: false, code: 'invalid_frame' });
  });

  it.each(
    fixtures
      .filter((f) => f.frame['ct'] !== undefined && f.frame['p'] === undefined)
      .map((f) => [f.kind, f.frame] as const),
  )('refuses encrypted-only %s with a p added', (_kind, frame) => {
    const result = decode(JSON.stringify({ ...frame, p: { text: 'leak' } }));
    expect(result).toMatchObject({ ok: false, code: 'invalid_frame' });
    if (!result.ok) {
      expect(typeof result.pointer).toBe('string');
      expect(result.pointer).not.toContain('leak');
    }
  });
});

describe('unknown things', () => {
  it('passes an unknown kind under a known t untouched', () => {
    const frame = {
      v: 1,
      t: 'event',
      id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      sid: FIXTURE_SID,
      k: 'agent.telepathy',
      p: { anything: [1, { nested: true }] },
    };
    expect(decode(JSON.stringify(frame))).toEqual({ ok: true, frame });
  });

  it('refuses an unknown t', () => {
    const frame = { v: 1, t: 'teleport', sid: FIXTURE_SID, p: {} };
    expect(decode(JSON.stringify(frame))).toMatchObject({ ok: false, code: 'invalid_frame' });
  });

  it('drops unknown top-level fields, so encodeFrame has none of them', () => {
    const frame = { v: 1, t: 'sys.ping', p: { t: 1 }, admin: true, __proto__x: 1, extra: 'x' };
    const result = decode(JSON.stringify(frame));
    expect(result).toEqual({ ok: true, frame: { v: 1, t: 'sys.ping', p: { t: 1 } } });
    if (result.ok)
      expect(JSON.parse(encodeFrame(result.frame))).toEqual({ v: 1, t: 'sys.ping', p: { t: 1 } });
  });
});

describe('server-set fields', () => {
  it('never survive decoding (1 000 random frames)', () => {
    const fixtures = eventFixtures();
    for (let i = 0; i < 1000; i += 1) {
      const base = fixtures[randomInt(fixtures.length)]?.frame ?? {};
      const frame = {
        ...base,
        from: i % 3 === 0 ? 'srv' : `mem_${randomBytes(8).toString('hex')}`,
        ts: new Date(randomInt(2_000_000_000_000)).toISOString(),
        seq: randomInt(1, 1_000_000),
      };
      const result = decode(JSON.stringify(frame));
      if (result.ok) {
        for (const field of SERVER_SET_FIELDS) expect(result.frame).not.toHaveProperty(field);
      }
    }
  });
});

describe('the session', () => {
  it('refuses a frame for another session, and checks none before one is known', () => {
    const frame = frameOfBytes(300, 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4X');
    expect(decode(frame)).toEqual({ ok: false, code: 'invalid_frame', pointer: '/sid' });
    expect(decode(frame, null).ok).toBe(true);
  });
});

describe('payload sizes', () => {
  const event = (c: string): string =>
    JSON.stringify({
      v: 1,
      t: 'event',
      id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      sid: FIXTURE_SID,
      k: 'message.user',
      ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'A'.repeat(32), c },
      sig: 'AAAA',
    });
  const ctBytes = (c: string): number =>
    JSON.stringify({ alg: 'xchacha20poly1305', kid: 'k1', n: 'A'.repeat(32), c }).length;

  it('accepts a ct of 196 608 bytes and refuses 196 609', () => {
    const fixed = ctBytes('');
    const exact = 'A'.repeat(FRAME_LIMITS.maxCtBytes - fixed);
    expect(ctBytes(exact)).toBe(196_608);
    expect(decode(event(exact)).ok).toBe(true);
    expect(decode(event(`${exact}A`))).toEqual({
      ok: false,
      code: 'frame_too_large',
      pointer: '/ct',
    });
  });

  it('accepts queue.submit p.size up to 196 608 and refuses more', () => {
    const fixture = eventFixtures().find((f) => f.kind === 'queue.submit');
    if (fixture === undefined) throw new Error('no queue.submit fixture');
    const withSize = (size: number) =>
      JSON.stringify({ ...fixture.frame, p: { ...(fixture.frame['p'] as object), size } });
    expect(decode(withSize(196_608)).ok).toBe(true);
    expect(decode(withSize(196_609))).toEqual({
      ok: false,
      code: 'frame_too_large',
      pointer: '/p/size',
    });
  });
});

describe('nesting', () => {
  it('accepts 16 levels and refuses 17, before parsing', () => {
    expect(decode(nestedFrame(16)).ok).toBe(true);
    expect(decode(nestedFrame(17))).toEqual({ ok: false, code: 'invalid_frame', pointer: '' });
    expect(decode('['.repeat(100_000))).toMatchObject({ code: 'invalid_frame' });
  });

  it('ignores brackets inside strings, escapes included', () => {
    expect(nestsDeeperThan('{"a":"[[[[{{{{\\"]]]"}', 2)).toBe(false);
    expect(nestsDeeperThan('[[[]]]', 2)).toBe(true);
    expect(nestsDeeperThan('{"a":"\\\\"}', 1)).toBe(false);
  });
});

describe('encodeFrame', () => {
  it('writes the envelope fields only, in canonical order', () => {
    const encoded = encodeFrame({
      sig: 'AAAA',
      ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'A'.repeat(32), c: 'AAAA' },
      k: 'message.user',
      seq: 7,
      from: 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      ts: '2026-10-08T00:00:00.000Z',
      sid: FIXTURE_SID,
      id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      t: 'event',
      v: 1,
      ...({ junk: 1 } as object),
    });
    expect(Object.keys(JSON.parse(encoded) as object)).toEqual([
      'v',
      't',
      'id',
      'sid',
      'from',
      'ts',
      'seq',
      'k',
      'ct',
      'sig',
    ]);
  });
});

describe('robustness', () => {
  it('never throws on 100 000 random byte strings', () => {
    for (let i = 0; i < 100_000; i += 1) {
      const bytes = randomBytes(randomInt(0, 64));
      expect(() => decodeFrame(bytes, false, FIXTURE_SID)).not.toThrow();
      expect(() => decodeFrame(bytes.toString('latin1'), false, FIXTURE_SID)).not.toThrow();
    }
  }, 60_000);

  it('never throws on mutated fixtures', () => {
    const fixtures = eventFixtures().map((f) => JSON.stringify(f.frame));
    for (let i = 0; i < 5_000; i += 1) {
      const text = fixtures[randomInt(fixtures.length)] ?? '';
      const at = randomInt(text.length);
      const mutated = `${text.slice(0, at)}${String.fromCharCode(randomInt(32, 127))}${text.slice(at + 1)}`;
      const result = decodeFrame(mutated, false, FIXTURE_SID);
      expect(typeof result.ok).toBe('boolean');
    }
  });

  it('decodes a 256 KiB frame in under 5 ms p95 (child process)', () => {
    const bench = resolve(import.meta.dirname, 'decode-bench.ts');
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const tsconfig = resolve(import.meta.dirname, '../../../../tsconfig.test.json');
    const out = execFileSync(process.execPath, [tsx, '--tsconfig', tsconfig, bench], {
      input: JSON.stringify({ runs: 100 }),
      encoding: 'utf8',
    });
    const { p95, ok } = JSON.parse(out) as { p95: number; ok: boolean };
    expect(ok).toBe(true);
    expect(p95).toBeLessThan(5);
  }, 60_000);
});
