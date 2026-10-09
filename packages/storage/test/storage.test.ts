/**
 * What `@centcom/storage` adds to B055's history and B082's object store (B042): a frame's `ref`
 * is kept (so the relay replays it as it was delivered) and a malformed one refused; the batch
 * format carries it; and the shared `OBJECT_STORE_*` settings are read and checked once for every
 * service.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { decodeBatch, encodeBatch, loadObjectStoreConfig, toStoredFrame } from '../src/index.js';

const frame = (extra: Record<string, unknown> = {}) => ({
  t: 'event',
  id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
  from: 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
  ts: '2026-10-09T08:00:00.000Z',
  seq: 7,
  k: 'message.user',
  ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'bg', c: 'Yw' },
  sig: 'c2ln',
  ...extra,
});

describe('ref', () => {
  it('is kept, and survives the batch format', () => {
    const kept = toStoredFrame(frame({ ref: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4X' }));
    expect(kept).toMatchObject({ ok: true, frame: { ref: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4X' } });
    if (!kept.ok) return;
    const [back] = decodeBatch(encodeBatch([kept.frame]).body);
    expect(back?.ref).toBe('msg_01JA3Z8K2M5N7P9Q0R1S2T3V4X');
  });

  it('is absent when the frame has none, and a malformed one is refused', () => {
    expect(toStoredFrame(frame())).toMatchObject({ ok: true });
    const none = toStoredFrame(frame());
    expect(none.ok && 'ref' in none.frame).toBe(false);
    for (const ref of ['nope', 42, 'msg_short']) {
      expect(toStoredFrame(frame({ ref }))).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('loadObjectStoreConfig', () => {
  const ENV = {
    OBJECT_STORE_ENDPOINT: 'https://r2.example.test/',
    OBJECT_STORE_REGION: 'auto',
    OBJECT_STORE_BUCKET: 'centcom-history',
    OBJECT_STORE_ACCESS_KEY_ID: 'id',
    OBJECT_STORE_SECRET_ACCESS_KEY: 'secret-value',
  };

  it('reads the keys, trims the endpoint and keeps the secrets secret', () => {
    const config = loadObjectStoreConfig(ENV);
    expect(config).toMatchObject({
      endpoint: 'https://r2.example.test',
      region: 'auto',
      bucket: 'centcom-history',
    });
    expect(config.secretAccessKey.reveal()).toBe('secret-value');
    expect(JSON.stringify(config)).not.toContain('secret-value');
    expect(loadObjectStoreConfig({ ...ENV, OBJECT_STORE_REGION: undefined }).region).toBe(
      'us-east-1',
    );
  });

  it('refuses missing or bad keys', () => {
    for (const bad of [
      { OBJECT_STORE_ENDPOINT: undefined },
      { OBJECT_STORE_ENDPOINT: 'ftp://x' },
      { OBJECT_STORE_BUCKET: 'Bad_Bucket' },
      { OBJECT_STORE_SECRET_ACCESS_KEY: undefined },
    ]) {
      expect(() => loadObjectStoreConfig({ ...ENV, ...bad }), JSON.stringify(bad)).toThrow(
        ConfigError,
      );
    }
  });
});
