/**
 * Idempotency records (B024): claiming, replaying, conflicts, the CT-PAGE wait for an in-flight
 * duplicate, what is never kept (5xx, oversized bodies, secret-bearing headers), sealed bodies,
 * unreadable records and the header parser. On every backend: in memory, and on Redis 7 when
 * REDIS_URL is set (CI's integration job).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppError,
  DEFAULT_MAX_STORED_BYTES,
  IDEMPOTENCY_KEY_POINTER,
  MAX_VALUE_BYTES,
  parseIdempotencyKey,
  STORED_HEADERS,
  storeKeyFor,
} from '../../src/index.js';
import { HARNESSES, type Harness } from '../redis/helpers.js';
import { captureLogger, countingMetrics, fp, jsonResponse, newKey, quickStore } from './helpers.js';

/** A store key nobody else uses. */
const freshKey = (): string => storeKeyFor(newId('usr'), 'POST', '/v1/things', randomUUID());

for (const [name, open, enabled] of HARNESSES) {
  describe.runIf(enabled)(`idempotency records: ${name}`, () => {
    let harness: Harness | undefined;
    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });
    const kvOf = async (): Promise<Harness['backend']['kv']> => {
      harness = await open();
      return harness.backend.kv;
    };

    it('claims a free key, then replays its response for the same request only', async () => {
      const kv = await kvOf();
      const store = quickStore(kv);
      const key = freshKey();
      expect(await store.claim(key, fp({ a: 1 }))).toEqual({ kind: 'claimed' });
      const response = jsonResponse(201, { id: 'thing' }, { location: '/v1/things/1' });
      expect(await store.complete(key, fp({ a: 1 }), response)).toBeUndefined();
      const again = await store.claim(key, fp({ a: 1 }));
      expect(again).toEqual({ kind: 'replay', response });
      expect(await store.claim(key, fp({ a: 2 }))).toEqual({ kind: 'conflict' });
    });

    it('keeps only safe headers: no Set-Cookie, Authorization, request id or rate-limit headers', async () => {
      const kv = await kvOf();
      const store = quickStore(kv);
      const key = freshKey();
      await store.claim(key, fp({}));
      const headers = {
        'content-type': 'application/json',
        'content-language': 'en',
        location: '/v1/things/1',
        etag: '"v1"',
        'last-modified': 'Wed, 07 Oct 2026 12:00:00 GMT',
        'set-cookie': 'session=abc',
        authorization: 'Bearer abc',
        'x-request-id': newId('req'),
        'ratelimit-remaining': '9',
      };
      await store.complete(key, fp({}), { status: 200, headers, body: Buffer.from('{}') });
      const stored = await kv.get(key);
      for (const secret of ['set-cookie', 'session=abc', 'authorization', 'Bearer', 'ratelimit']) {
        expect(stored).not.toContain(secret);
      }
      const replay = await store.claim(key, fp({}));
      expect(replay.kind === 'replay' ? Object.keys(replay.response.headers).sort() : []).toEqual(
        [...STORED_HEADERS].sort(),
      );
    });

    it('keeps text as text and other bytes exactly', async () => {
      const kv = await kvOf();
      const store = quickStore(kv);
      const binary = Buffer.from([0xff, 0x00, 0xfe, 0x80]);
      const key = freshKey();
      await store.claim(key, fp('bytes'));
      await store.complete(key, fp('bytes'), { status: 200, headers: {}, body: binary });
      expect(JSON.parse((await kv.get(key)) ?? '{}')).toMatchObject({ enc: 'base64' });
      const replay = await store.claim(key, fp('bytes'));
      expect(replay.kind === 'replay' && replay.response.body.equals(binary)).toBe(true);
      const text = freshKey();
      await store.claim(text, fp('text'));
      await store.complete(text, fp('text'), jsonResponse(200, { é: '✓' }));
      expect(JSON.parse((await kv.get(text)) ?? '{}')).toMatchObject({ enc: 'utf8' });
    });

    it('never keeps a 5xx or an oversized body, and frees the key for a retry', async () => {
      const kv = await kvOf();
      const store = quickStore(kv);
      const failed = freshKey();
      await store.claim(failed, fp({}));
      expect(await store.complete(failed, fp({}), jsonResponse(503, {}))).toBe('server_error');
      expect(await store.claim(failed, fp({}))).toEqual({ kind: 'claimed' });
      const big = freshKey();
      await store.claim(big, fp({}));
      const body = Buffer.alloc(DEFAULT_MAX_STORED_BYTES + 1, 'a');
      expect(await store.complete(big, fp({}), { status: 200, headers: {}, body })).toBe(
        'too_large',
      );
      expect(await store.claim(big, fp({}))).toEqual({ kind: 'claimed' });
      // A route may allow more, up to what one stored value can hold.
      expect(
        await store.complete(
          big,
          fp({}),
          { status: 200, headers: {}, body },
          { maxBytes: body.length },
        ),
      ).toBeUndefined();
      const huge = freshKey();
      await store.claim(huge, fp({}));
      const tooBig = Buffer.alloc(MAX_VALUE_BYTES, 'a');
      expect(
        await store.complete(
          huge,
          fp({}),
          { status: 200, headers: {}, body: tooBig },
          { maxBytes: tooBig.length },
        ),
      ).toBe('too_large');
      expect(await kv.get(huge)).toBeNull();
    });

    it('keeps 4xx responses for replay', async () => {
      const kv = await kvOf();
      const store = quickStore(kv);
      const key = freshKey();
      await store.claim(key, fp({}));
      const problem = jsonResponse(422, { code: 'validation_failed' });
      expect(await store.complete(key, fp({}), problem)).toBeUndefined();
      expect(await store.claim(key, fp({}))).toEqual({ kind: 'replay', response: problem });
    });

    it('seals sensitive bodies and opens them on replay', async () => {
      const kv = await kvOf();
      const encryptionKey = newKey();
      const store = quickStore(kv, { encryptionKey });
      const marker = randomBytes(12).toString('hex');
      const key = freshKey();
      await store.claim(key, fp({}));
      const response = jsonResponse(201, { created: marker });
      await store.complete(key, fp({}), response, { sensitive: true });
      const raw = (await kv.get(key)) ?? '';
      expect(raw).not.toContain(marker);
      expect(JSON.parse(raw)).toMatchObject({ enc: 'aes-256-gcm' });
      expect(await store.claim(key, fp({}))).toEqual({ kind: 'replay', response });
      // Without the key there is nothing to seal with.
      await expect(
        quickStore(kv).complete(freshKey(), fp({}), response, { sensitive: true }),
      ).rejects.toThrow(TypeError);
    });

    it('waits for an in-flight duplicate: its result, its release, or the deadline', async () => {
      const kv = await kvOf();
      const store = quickStore(kv, { inFlightWaitMs: 2_000 });
      const key = freshKey();
      await store.claim(key, fp({}));
      const waiting = store.claim(key, fp({}));
      setTimeout(() => void store.complete(key, fp({}), jsonResponse(200, { ok: 1 })), 30);
      expect((await waiting).kind).toBe('replay');
      // Released (a 5xx): the waiting duplicate claims the key and runs.
      const released = freshKey();
      await store.claim(released, fp({}));
      const retry = store.claim(released, fp({}));
      setTimeout(() => void store.release(released), 30);
      expect(await retry).toEqual({ kind: 'claimed' });
      // Still running at the deadline.
      const slow = freshKey();
      await quickStore(kv).claim(slow, fp({}));
      expect(await quickStore(kv, { inFlightWaitMs: 50 }).claim(slow, fp({}))).toEqual({
        kind: 'in_flight',
      });
      // A different request under a running key is a conflict at once.
      expect(await quickStore(kv, { inFlightWaitMs: 60_000 }).claim(slow, fp({ b: 1 }))).toEqual({
        kind: 'conflict',
      });
    });

    it('treats an unreadable or unverifiable record as lost: deleted, counted, logged', async () => {
      const kv = await kvOf();
      const log = captureLogger();
      const counters = countingMetrics();
      const encryptionKey = newKey();
      const store = quickStore(kv, {
        encryptionKey,
        logger: log.logger,
        metrics: counters.metrics,
      });
      const bad = [
        'not json',
        JSON.stringify({ v: 2, state: 'done' }),
        JSON.stringify({ v: 1, state: 'other', fp: fp({}), at: 0 }),
        JSON.stringify({
          v: 1,
          state: 'done',
          fp: fp({}),
          at: 0,
          status: 200,
          headers: { a: 1 },
          enc: 'utf8',
          body: '',
        }),
        JSON.stringify({
          v: 1,
          state: 'done',
          fp: fp({}),
          at: 0,
          status: 200,
          headers: {},
          enc: 'rot13',
          body: '',
        }),
      ];
      for (const raw of bad) {
        const key = freshKey();
        await kv.set(key, raw);
        expect(await store.claim(key, fp({}))).toEqual({ kind: 'claimed' });
      }
      // A sealed record that was altered, or that this store has no key to open.
      const tampered = freshKey();
      await store.claim(tampered, fp({}));
      await store.complete(tampered, fp({}), jsonResponse(200, {}), { sensitive: true });
      const record = JSON.parse((await kv.get(tampered)) ?? '{}') as Record<string, string>;
      await kv.set(
        tampered,
        JSON.stringify({ ...record, body: Buffer.from('forged').toString('base64') }),
      );
      expect(await store.claim(tampered, fp({}))).toEqual({ kind: 'claimed' });
      const keyless = freshKey();
      await store.claim(keyless, fp({}));
      await store.complete(keyless, fp({}), jsonResponse(200, {}), { sensitive: true });
      expect(await quickStore(kv).claim(keyless, fp({}))).toEqual({ kind: 'claimed' });
      expect(counters.count('idempotency_invalid_records_total')).toBe(bad.length + 1);
      expect(log.lines().filter((l) => l['msg'] === 'idempotency.invalid_record')).toHaveLength(
        bad.length + 1,
      );
    });
  });
}

describe('parseIdempotencyKey', () => {
  it('takes one ULID or UUID, normalising its case, and nothing when the header is absent', () => {
    const ulid = newId('req').slice(4);
    const uuid = randomUUID();
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey(ulid.toLowerCase())).toBe(ulid);
    expect(parseIdempotencyKey(uuid.toUpperCase())).toBe(uuid);
  });

  it.each([
    ['too long', 'a'.repeat(65), 'too_long'],
    ['an empty value', '', 'invalid_format'],
    ['a prefixed id', 'req_PLACEHOLDER', 'invalid_format'],
    ['a UUID without dashes', 'f'.repeat(32), 'invalid_format'],
    ['two keys', 'TWO,KEYS', 'invalid_format'],
  ])('refuses %s with a problem pointing at the header', (_name, value, code) => {
    let error: unknown;
    try {
      parseIdempotencyKey(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'validation_failed',
      errors: [{ pointer: IDEMPOTENCY_KEY_POINTER, code }],
    });
  });

  it('refuses a repeated header', () => {
    const uuid = randomUUID();
    expect(() => parseIdempotencyKey([uuid, uuid])).toThrow(AppError);
  });
});
