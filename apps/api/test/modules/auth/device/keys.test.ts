/**
 * Device public keys (B016 acceptance 5; card test keys.test.ts): the validation table for the
 * keys a terminal sends, the field pointers of a refused start, and the CT-CRYPTO fingerprint,
 * checked against vectors computed independently with Python's hashlib BLAKE2b-256.
 */
import { describe, expect, it } from 'vitest';
import {
  checkDevicePublicKeys,
  checkPublicKey,
  deviceFingerprint,
} from '../../../../src/modules/auth/device/keys.js';
import { deviceHarness, startBody, validKeys } from './helpers.js';

const bytes = (n: number, fill = 1): string => Buffer.alloc(n, fill).toString('base64url');

describe('one public key', () => {
  it.each([
    ['32 random bytes', validKeys().x25519, undefined],
    ['32 bytes of 0x01', bytes(32), undefined],
    ['31 bytes', bytes(31), 'invalid_format'],
    ['33 bytes', bytes(33), 'invalid_format'],
    ['standard base64 (+ and /)', `${'+'.repeat(42)}A`, 'invalid_format'],
    ['padded', `${bytes(32)}=`, 'invalid_format'],
    ['spare bits set in the last character', `${bytes(32).slice(0, 42)}B`, 'invalid_format'],
    ['with whitespace', ` ${bytes(32).slice(1)}`, 'invalid_format'],
    ['all zero', bytes(32, 0), 'invalid_value'],
    ['empty', '', 'invalid_format'],
    ['a number', 42, 'invalid_type'],
    ['null', null, 'invalid_type'],
    ['missing', undefined, 'required'],
  ])('%s: %s', (_label, value, problem) => {
    expect(checkPublicKey(value)).toBe(problem);
  });
});

describe('device_pubkeys', () => {
  it('passes two valid keys through', () => {
    const keys = validKeys();
    expect(checkDevicePublicKeys(keys)).toEqual({ keys });
  });

  it('points at each bad key, and at keys it does not know', () => {
    expect(checkDevicePublicKeys({ x25519: bytes(31), ed25519: bytes(32, 0), rsa: 'x' })).toEqual({
      errors: [
        { pointer: '/device_pubkeys/x25519', code: 'invalid_format', detail: expect.any(String) },
        { pointer: '/device_pubkeys/ed25519', code: 'invalid_value', detail: expect.any(String) },
        { pointer: '/device_pubkeys/rsa', code: 'not_allowed', detail: expect.any(String) },
      ],
    });
  });

  it('refuses a missing or non-object value', () => {
    for (const value of [undefined, null, 'keys', [validKeys()]]) {
      const result = checkDevicePublicKeys(value);
      expect('errors' in result && result.errors[0]?.pointer).toBe('/device_pubkeys');
    }
  });
});

describe('a start with bad fields (acceptance 5)', () => {
  it.each([
    ['x25519 of 31 bytes', { x25519: bytes(31), ed25519: bytes(32) }, '/device_pubkeys/x25519'],
    [
      'x25519 not base64url',
      { x25519: '!'.repeat(43), ed25519: bytes(32) },
      '/device_pubkeys/x25519',
    ],
    ['x25519 all zero', { x25519: bytes(32, 0), ed25519: bytes(32) }, '/device_pubkeys/x25519'],
    ['ed25519 of 31 bytes', { x25519: bytes(32), ed25519: bytes(31) }, '/device_pubkeys/ed25519'],
    [
      'ed25519 not base64url',
      { x25519: bytes(32), ed25519: `${bytes(32).slice(0, 42)}*` },
      '/device_pubkeys/ed25519',
    ],
    ['ed25519 all zero', { x25519: bytes(32), ed25519: bytes(32, 0) }, '/device_pubkeys/ed25519'],
  ])('%s is a 422 pointing at %s', async (_label, keys, pointer) => {
    const h = await deviceHarness();
    const res = await h.start(startBody({ device_pubkeys: keys }));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      type: 'https://centcom.dev/errors/validation_failed',
      code: 'validation_failed',
      errors: [{ pointer, code: expect.any(String) }],
    });
    expect(h.store.rows.size).toBe(0);
  });

  it.each(['centcom-desktop', '', 42, undefined])(
    'an unknown client_id %j is a 401 invalid_client pointing at /client_id',
    async (clientId) => {
      const h = await deviceHarness();
      const res = await h.start(startBody({ client_id: clientId }));
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        code: 'invalid_client',
        errors: [{ pointer: '/client_id', code: 'invalid_value' }],
      });
    },
  );

  it('lists every bad field at once', async () => {
    const h = await deviceHarness();
    const res = await h.start({
      client_id: 'centcom-cli',
      scope: 7,
      device_name: '',
      device_pubkeys: { x25519: bytes(31) },
      extra: true,
    });
    expect(res.status).toBe(422);
    expect((res.body['errors'] as { pointer: string }[]).map((e) => e.pointer)).toEqual([
      '/scope',
      '/device_name',
      '/device_pubkeys/x25519',
      '/device_pubkeys/ed25519',
      '/extra',
    ]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['81 characters', 'x'.repeat(81)],
    ['a control character', 'box\u0007'],
    ['not a string', 7],
  ])('a device_name that is %s is refused', async (_label, name) => {
    const h = await deviceHarness();
    const res = await h.start(startBody({ device_name: name }));
    expect(res.status).toBe(422);
    expect(res.body['errors']).toEqual([expect.objectContaining({ pointer: '/device_name' })]);
  });

  it('accepts an 80-character name, emoji counted as one character', async () => {
    const h = await deviceHarness();
    expect((await h.start(startBody({ device_name: `${'x'.repeat(79)}🐙` }))).status).toBe(200);
  });

  it('refuses a body that is not an object', async () => {
    const h = await deviceHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: '["centcom-cli"]',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ errors: [{ pointer: '', code: 'invalid_type' }] });
  });
});

describe('the fingerprint (CT-CRYPTO §1)', () => {
  // Computed with Python: base64.b32encode(hashlib.blake2b(x + e, digest_size=32).digest())[:12]
  // (the dev stack's seed devices, B012).
  it.each([
    [
      'rjNaDJZfZXgceCLpPpS3VR_m0l_UiNOOy12xIODtYAs',
      '4DM5_5Js4_6-ROaQJH1o-27jm1D3byA5kxzcC4YOUts',
      '3OE7-23IB-PN3N',
    ],
    [
      'FhjOgOBRLpqZWkjIkDyRyQjsqHb8R5rupyESVf01oVo',
      '3h52evDDAdlgLTkxGYg6sfOD8oslNEMm2MTiV-n2hRk',
      'IJIC-IOIW-BMYN',
    ],
  ])('of %s and %s is %s', (x25519, ed25519, fingerprint) => {
    expect(deviceFingerprint({ x25519, ed25519 })).toBe(fingerprint);
  });

  it('is ABCD-EFGH-IJKL in base32, and depends on both keys and their order', () => {
    const keys = validKeys();
    const fp = deviceFingerprint(keys);
    expect(fp).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(deviceFingerprint({ x25519: keys.ed25519, ed25519: keys.x25519 })).not.toBe(fp);
    expect(deviceFingerprint({ ...keys, ed25519: validKeys().ed25519 })).not.toBe(fp);
  });
});
