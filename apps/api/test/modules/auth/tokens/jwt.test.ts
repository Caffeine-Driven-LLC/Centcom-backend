/**
 * Access tokens (B017 acceptance 1 and 6, card test jwt.test.ts): the header and every CT-AUTH
 * claim, `exp - iat` = 900, the 60 s skew and no more, algorithm confusion (`none`, HS256)
 * refused, unknown and wrong keys, other audiences and token types, and tokens from the future.
 */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_S,
  API_AUDIENCE,
  generateSigningJwk,
  signAccessToken,
  signJwt,
  TOKEN_ISSUER,
  verifyAccessJwt,
  type AccessTokenInput,
} from '../../../../src/modules/auth/tokens/index.js';
import { keySet, newId, singleKey, T0 } from './helpers.js';

const decode = (part: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

const input = (
  overrides: Partial<AccessTokenInput> = {},
): AccessTokenInput & Record<string, unknown> => ({
  sub: newId('usr'),
  scp: 'profile sessions:read',
  plan: 'pro',
  ent: 7,
  dev: newId('dev'),
  wsp: newId('wsp'),
  ...overrides,
});

/** The code of the AppError a verification rejects with. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  const err = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: string } | undefined;
  return err?.code ?? 'accepted';
}

describe('access tokens', () => {
  it('carry alg EdDSA, kid and typ at+jwt, every CT-AUTH claim, exp - iat = 900 and aud centcom-api (acceptance 1)', async () => {
    const keys = singleKey();
    const claimsIn = input();
    const { token, claims } = await signAccessToken(keys, claimsIn, T0);
    const [header, payload] = token.split('.');
    expect(decode(header)).toEqual({ alg: 'EdDSA', kid: 'k1', typ: 'at+jwt' });
    const decoded = decode(payload);
    expect(Object.keys(decoded).sort()).toEqual([
      'aud',
      'dev',
      'ent',
      'exp',
      'iat',
      'iss',
      'jti',
      'plan',
      'scp',
      'sub',
      'wsp',
    ]);
    expect(decoded).toMatchObject({
      ...claimsIn,
      iss: TOKEN_ISSUER,
      aud: API_AUDIENCE,
      iat: T0 / 1000,
    });
    expect(Number(decoded['exp']) - Number(decoded['iat'])).toBe(ACCESS_TOKEN_TTL_S);
    expect(ACCESS_TOKEN_TTL_S).toBe(900);
    expect(decoded['jti']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await verifyAccessJwt(keys, token, T0)).toEqual(claims);
    // dev and wsp are optional claims.
    const bare = await signAccessToken(
      keys,
      { sub: claimsIn.sub, scp: 'profile', plan: 'free', ent: 0 },
      T0,
    );
    expect(Object.keys(decode(bare.token.split('.')[1]))).not.toContain('dev');
  });

  it('tolerates 60 s of clock skew, and not a second more', async () => {
    const keys = singleKey();
    const { token } = await signAccessToken(keys, input(), T0);
    const exp = T0 + ACCESS_TOKEN_TTL_S * 1000;
    expect(await rejection(verifyAccessJwt(keys, token, exp + 60_000 - 1))).toBe('accepted');
    expect(await rejection(verifyAccessJwt(keys, token, exp + 61_000))).toBe('token_expired');
    // A token issued up to 60 s in "our" future (the issuer's clock ahead) is fine; beyond, it is not ours.
    expect(await rejection(verifyAccessJwt(keys, token, T0 - 60_000))).toBe('accepted');
    expect(await rejection(verifyAccessJwt(keys, token, T0 - 61_000))).toBe('token_invalid');
  });

  it('refuses alg none and HMAC tokens (algorithm confusion)', async () => {
    const keys = singleKey();
    const { token } = await signAccessToken(keys, input(), T0);
    const [, payload] = token.split('.');
    const header = (h: object): string => Buffer.from(JSON.stringify(h)).toString('base64url');
    const none = `${header({ alg: 'none', typ: 'at+jwt', kid: 'k1' })}.${payload}.`;
    expect(await rejection(verifyAccessJwt(keys, none, T0))).toBe('token_invalid');
    // HS256 keyed with the public key's bytes: the classic confusion attack.
    const hsHeader = header({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' });
    const secret = Buffer.from(keys.active.x, 'base64url');
    const mac = createHmac('sha256', secret).update(`${hsHeader}.${payload}`).digest('base64url');
    expect(await rejection(verifyAccessJwt(keys, `${hsHeader}.${payload}.${mac}`, T0))).toBe(
      'token_invalid',
    );
  });

  it('refuses a token signed by an unknown key, an unknown kid, or a tampered signature or payload', async () => {
    const keys = singleKey();
    const stranger = keySet([generateSigningJwk('k1')], 'k1'); // same kid, different key
    const { token } = await signAccessToken(stranger, input(), T0);
    expect(await rejection(verifyAccessJwt(keys, token, T0))).toBe('token_invalid');
    const unknownKid = keySet([generateSigningJwk('k9')], 'k9');
    expect(
      await rejection(
        verifyAccessJwt(keys, (await signAccessToken(unknownKid, input(), T0)).token, T0),
      ),
    ).toBe('token_invalid');

    const good = (await signAccessToken(keys, input(), T0)).token;
    const [h, p, s] = good.split('.');
    const flipped = `${h}.${p}.${(s ?? '').startsWith('A') ? 'B' : 'A'}${(s ?? '').slice(1)}`;
    expect(await rejection(verifyAccessJwt(keys, flipped, T0))).toBe('token_invalid');
    const otherPayload = Buffer.from(JSON.stringify({ ...decode(p), scp: 'admin' })).toString(
      'base64url',
    );
    expect(await rejection(verifyAccessJwt(keys, `${h}.${otherPayload}.${s}`, T0))).toBe(
      'token_invalid',
    );
    for (const garbage of [
      '',
      'a.b',
      'a.b.c',
      'Bearer x',
      createHash('sha256').update('x').digest('hex'),
    ]) {
      expect(await rejection(verifyAccessJwt(keys, garbage, T0)), garbage).toBe('token_invalid');
    }
  });

  it('refuses another audience, another token type, a foreign issuer and malformed claims', async () => {
    const keys = singleKey();
    const sign = (
      payload: Record<string, unknown>,
      typ = 'at+jwt',
      audience = API_AUDIENCE,
    ): Promise<string> => signJwt(keys, payload, { typ, audience, ttlS: 900, nowMs: T0 });
    const claims = input();
    expect(
      await rejection(verifyAccessJwt(keys, await sign(claims, 'at+jwt', 'centcom-relay'), T0)),
    ).toBe('token_invalid');
    expect(await rejection(verifyAccessJwt(keys, await sign(claims, 'JWT'), T0))).toBe(
      'token_invalid',
    );
    for (const broken of [
      { ...claims, sub: 'someone' },
      { ...claims, plan: 'gold' },
      { ...claims, ent: -1 },
      { ...claims, ent: 1.5 },
      { ...claims, dev: 'phone' },
      { ...claims, wsp: 42 },
      { ...claims, scp: ['profile'] },
    ]) {
      expect(
        await rejection(verifyAccessJwt(keys, await sign(broken), T0)),
        JSON.stringify(broken),
      ).toBe('token_invalid');
    }
    // signJwt always sets our issuer; a token of another issuer fails too.
    const { token } = await signAccessToken(keys, claims, T0);
    const [h, p] = token.split('.');
    const foreign = Buffer.from(
      JSON.stringify({ ...decode(p), iss: 'https://evil.example' }),
    ).toString('base64url');
    expect(await rejection(verifyAccessJwt(keys, `${h}.${foreign}.x`, T0))).toBe('token_invalid');
  });
});
