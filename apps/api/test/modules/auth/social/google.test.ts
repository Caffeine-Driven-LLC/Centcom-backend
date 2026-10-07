/**
 * Google ID tokens (B015 acceptance 3, card test google.test.ts): one test per refusal (wrong
 * `aud`, wrong `iss`, expired `exp`, bad signature, wrong `nonce`, `email_verified=false`), plus
 * algorithm confusion, unknown keys (one JWKS refetch), and a full login.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_JWKS_REFETCH_MS,
  GoogleKeys,
  verifyGoogleIdToken,
} from '../../../../src/modules/auth/social/index.js';
import {
  begun,
  fakeProviders,
  GOOGLE_CLIENT,
  googleIdToken,
  googleSigningKey,
  socialService,
  T0,
} from './helpers.js';

const NONCE = 'nonce-0123456789';
const claims = { sub: '108000000000000000001', email: 'gina@example.test', nonce: NONCE };

function keysFor(providers = fakeProviders(), now = () => T0): GoogleKeys {
  return new GoogleKeys({ fetch: providers.fetch, timeoutMs: 1_000 }, now);
}

const verify = (token: string, providers = fakeProviders(), nowMs = T0) =>
  verifyGoogleIdToken(token, {
    clientId: GOOGLE_CLIENT,
    nonce: NONCE,
    keys: keysFor(providers, () => nowMs),
    nowMs,
  });

describe('Google ID token verification', () => {
  it('accepts a valid token and returns sub, email and name', async () => {
    expect(await verify(await googleIdToken({ ...claims, name: 'Gina' }))).toEqual({
      sub: claims.sub,
      email: claims.email,
      name: 'Gina',
    });
    // Google also issues the bare host as `iss`.
    expect((await verify(await googleIdToken(claims, { issuer: 'accounts.google.com' }))).sub).toBe(
      claims.sub,
    );
  });

  it('refuses a wrong aud (acceptance 3)', async () => {
    await expect(
      verify(await googleIdToken(claims, { audience: 'someone-else.apps.googleusercontent.test' })),
    ).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
  });

  it('refuses a wrong iss (acceptance 3)', async () => {
    await expect(
      verify(await googleIdToken(claims, { issuer: 'https://accounts.evil.example' })),
    ).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
  });

  it('refuses an expired token, beyond the 60 s skew (acceptance 3)', async () => {
    const token = await googleIdToken(claims, { ttlS: 3600 });
    expect((await verify(token, fakeProviders(), T0 + 3600_000 + 59_000)).sub).toBe(claims.sub);
    await expect(verify(token, fakeProviders(), T0 + 3600_000 + 61_000)).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
  });

  it('refuses a bad signature (acceptance 3)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(verify(await googleIdToken(claims, { key: privateKey }))).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
    const token = await googleIdToken(claims);
    const [h, p, s] = token.split('.');
    await expect(
      verify(`${h}.${p}.${(s ?? '').startsWith('A') ? 'B' : 'A'}${(s ?? '').slice(1)}`),
    ).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
  });

  it('refuses a wrong nonce, and one that is missing (acceptance 3)', async () => {
    await expect(
      verify(await googleIdToken({ ...claims, nonce: 'other-nonce' })),
    ).rejects.toMatchObject({ reason: 'invalid_identity' });
    const withoutNonce = { sub: claims.sub, email: claims.email };
    await expect(verify(await googleIdToken(withoutNonce))).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
  });

  it('refuses email_verified=false, a string "true" and a missing address (acceptance 3)', async () => {
    await expect(
      verify(await googleIdToken({ ...claims, email_verified: false })),
    ).rejects.toMatchObject({
      reason: 'no_verified_email',
    });
    await expect(
      verify(await googleIdToken({ ...claims, email_verified: 'true' })),
    ).rejects.toMatchObject({
      reason: 'no_verified_email',
    });
    const withoutEmail = { sub: claims.sub, nonce: NONCE };
    await expect(verify(await googleIdToken(withoutEmail))).rejects.toMatchObject({
      reason: 'no_verified_email',
    });
  });

  it('refuses HS256 and alg none (algorithm confusion)', async () => {
    const token = await googleIdToken(claims);
    const [, payload] = token.split('.');
    const header = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
    await expect(
      verify(`${header({ alg: 'none', kid: 'google-test-1' })}.${payload}.`),
    ).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
    await expect(
      verify(`${header({ alg: 'HS256', kid: 'google-test-1' })}.${payload}.c2ln`),
    ).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
  });

  it('refetches the JWKS once for an unknown kid (Google rotated), at most once a minute', async () => {
    const providers = fakeProviders();
    let now = T0;
    const keys = keysFor(providers, () => now);
    const opts = () => ({ clientId: GOOGLE_CLIENT, nonce: NONCE, keys, nowMs: now });
    await verifyGoogleIdToken(await googleIdToken(claims), opts());
    // Google starts signing with a key we have not fetched yet.
    const rotated = googleSigningKey('google-test-2');
    providers.google.jwks = { keys: [rotated.jwk] };
    now += GOOGLE_JWKS_REFETCH_MS;
    expect(
      (await verifyGoogleIdToken(await googleIdToken(claims, { kid: 'google-test-2' }), opts()))
        .sub,
    ).toBe(claims.sub);
    const jwksCalls = () =>
      providers.calls.filter((call) => call.url.endsWith('/oauth2/v3/certs')).length;
    expect(jwksCalls()).toBe(2);
    // An unknown kid right after a fetch does not hammer Google.
    await expect(
      verifyGoogleIdToken(await googleIdToken(claims, { kid: 'nobody' }), opts()),
    ).rejects.toMatchObject({
      reason: 'invalid_identity',
    });
    expect(jwksCalls()).toBe(2);
  });

  it('treats an unreachable JWKS as a provider failure', async () => {
    const providers = fakeProviders();
    providers.google.jwks = { nope: true };
    await expect(verify(await googleIdToken(claims), providers)).rejects.toMatchObject({
      reason: 'provider',
    });
  });
});

describe('Google login', () => {
  it('exchanges the code with the PKCE verifier and signs the verified account in', async () => {
    const { service, providers, users } = socialService();
    const { state, cookie } = await begun(service, providers, 'google');
    const done = await service.complete('google', { code: 'google-code', state }, cookie);
    expect(done).toMatchObject({ returnTo: 'https://app.centcom.test/', created: true });
    expect(users.users.get('gina@example.test')?.id).toBe(done.userId);
    const exchange = new URLSearchParams(
      providers.calls.find((call) => call.method === 'POST')?.body,
    );
    expect(Object.fromEntries(exchange)).toMatchObject({
      code: 'google-code',
      grant_type: 'authorization_code',
      redirect_uri: 'https://api.centcom.test/login/google/callback',
    });
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a token endpoint without an ID token, or one that says no', async () => {
    const { service, providers } = socialService();
    providers.google.token = () => Promise.resolve({ access_token: 'only-an-access-token' });
    const first = await begun(service, providers, 'google');
    await expect(
      service.complete('google', { code: 'c', state: first.state }, first.cookie),
    ).rejects.toMatchObject({ reason: 'denied' });
    providers.google.tokenStatus = 400;
    providers.google.token = () => Promise.resolve({ error: 'invalid_grant' });
    const second = await begun(service, providers, 'google');
    await expect(
      service.complete('google', { code: 'c', state: second.state }, second.cookie),
    ).rejects.toMatchObject({
      reason: 'denied',
    });
  });
});
