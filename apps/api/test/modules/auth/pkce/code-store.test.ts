/**
 * Authorization codes (B018 acceptance 3 and 4; tests "code-store.test.ts"): single use, the
 * 60-second lifetime on a fake clock, binding to client and redirect URI, records that hold no
 * code or token in clear, and the replay record that only the code's holder can open.
 */
import { createHash } from 'node:crypto';
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  AuthorizationCodeStore,
  CODE_TTL_MS,
  openWithCode,
  sealWithCode,
  type CodeGrant,
} from '../../../../src/modules/auth/pkce/code-store.js';
import { T0, testClock } from '../tokens/helpers.js';
import {
  authorizeParams,
  exchange,
  issueCode,
  newId,
  pkceApp,
  pkcePair,
  recordingKv,
} from './helpers.js';

const grant = (): CodeGrant => ({
  clientId: 'centcom-cli',
  redirectUri: 'http://127.0.0.1:5000/callback',
  codeChallenge: pkcePair().challenge,
  userId: newId('usr'),
  scope: 'profile',
});

/** A store on a fresh in-memory Redis whose clock the test moves. */
function memoryStore() {
  const clock = testClock();
  const kv = recordingKv(createMemoryRedis(clock.now).kv);
  return { store: new AuthorizationCodeStore({ kv }), kv, clock };
}

describe('AuthorizationCodeStore', () => {
  it('issues a 256-bit code that is claimed once, then only replayed', async () => {
    const { store, clock } = memoryStore();
    const bound = grant();
    const code = await store.issue(bound, clock.now());
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.claim(code, clock.now())).toEqual({ kind: 'claimed', grant: bound });
    expect(await store.claim(code, clock.now())).toEqual({ kind: 'replayed', issued: null });
    expect(await store.claim(code, clock.now())).toEqual({ kind: 'replayed', issued: null });
  });

  it('lets a code live 60 seconds', async () => {
    const { store, clock } = memoryStore();
    const early = await store.issue(grant(), clock.now());
    const late = await store.issue(grant(), clock.now());
    clock.advance(CODE_TTL_MS - 1);
    expect((await store.claim(early, clock.now())).kind).toBe('claimed');
    clock.advance(2);
    expect((await store.claim(late, clock.now())).kind).toBe('unknown');
  });

  it('rejects a code past 60 s by its own clock even while Redis still holds it', async () => {
    const kv = createMemoryRedis(() => T0).kv;
    const store = new AuthorizationCodeStore({ kv });
    const code = await store.issue(grant(), T0);
    expect((await store.claim(code, T0 + CODE_TTL_MS)).kind).toBe('unknown');
  });

  it('knows nothing of codes it never issued, or of malformed ones', async () => {
    const { store, clock } = memoryStore();
    for (const code of ['', 'short', 'a'.repeat(43), `${'a'.repeat(42)}+`]) {
      expect(await store.claim(code, clock.now())).toEqual({ kind: 'unknown' });
    }
  });

  it('treats an unreadable record as unknown', async () => {
    const clock = testClock();
    const redis = createMemoryRedis(clock.now);
    const store = new AuthorizationCodeStore({ kv: redis.kv });
    const code = await store.issue(grant(), clock.now());
    const key = `auth:code:${createHash('sha256').update(code).digest('hex')}`;
    await redis.kv.set(key, '{"cid":"evil-cli"}', { ttlMs: CODE_TTL_MS });
    expect(await store.claim(code, clock.now())).toEqual({ kind: 'unknown' });
    const second = await store.issue(grant(), clock.now());
    const key2 = `auth:code:${createHash('sha256').update(second).digest('hex')}`;
    await redis.kv.set(key2, 'not json', { ttlMs: CODE_TTL_MS });
    expect(await store.claim(second, clock.now())).toEqual({ kind: 'unknown' });
  });

  it('stores neither the code nor a token in clear', async () => {
    const { store, kv, clock } = memoryStore();
    const code = await store.issue(grant(), clock.now());
    await store.claim(code, clock.now());
    const refreshToken = 'r'.repeat(43);
    await store.recordIssued(code, { userId: newId('usr'), jti: 'j1', exp: 1, refreshToken });
    for (const { key, value } of kv.writes) {
      expect(key).not.toContain(code);
      expect(value).not.toContain(code);
      expect(value).not.toContain(refreshToken);
    }
  });

  it('hands what an exchange issued to whoever replays its code, and to nobody else', async () => {
    const { store, clock } = memoryStore();
    const userId = newId('usr');
    const code = await store.issue({ ...grant(), userId }, clock.now());
    await store.claim(code, clock.now());
    const issued = { userId, jti: 'jti-1', exp: 1_900_000_000, refreshToken: 'r'.repeat(43) };
    expect(await store.recordIssued(code, issued)).toBe(false);
    expect(await store.claim(code, clock.now())).toEqual({ kind: 'replayed', issued });
    // The sealed refresh token opens with its own code only.
    const sealed = sealWithCode(code, issued.refreshToken);
    expect(openWithCode(code, sealed)).toBe(issued.refreshToken);
    expect(
      openWithCode(`${code.slice(0, 42)}${code[42] === 'A' ? 'B' : 'A'}`, sealed),
    ).toBeUndefined();
    expect(openWithCode(code, 'tooshort')).toBeUndefined();
  });

  it('tells the winner of a race that the code was replayed meanwhile', async () => {
    const { store, clock } = memoryStore();
    const code = await store.issue(grant(), clock.now());
    expect((await store.claim(code, clock.now())).kind).toBe('claimed');
    // The replay arrives before the winner has recorded its tokens.
    expect(await store.claim(code, clock.now())).toEqual({ kind: 'replayed', issued: null });
    const issued = { userId: newId('usr'), jti: 'jti-2', exp: 1_900_000_000 };
    expect(await store.recordIssued(code, issued)).toBe(true);
  });
});

describe('code binding at the token endpoint', () => {
  const redirectUri = 'http://127.0.0.1:53682/callback';

  it('rejects a code exchanged with another redirect_uri, and burns it', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    const other = await exchange(h.app, {
      code,
      verifier: pair.verifier,
      redirectUri: 'http://127.0.0.1:53683/callback',
    });
    expect(other.statusCode).toBe(400);
    expect(other.json()).toMatchObject({ code: 'invalid_grant' });
    const right = await exchange(h.app, { code, verifier: pair.verifier, redirectUri });
    expect(right.json()).toMatchObject({ code: 'invalid_grant' });
    await h.app.close();
  });

  it('rejects a code exchanged by another client', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    const res = await exchange(h.app, {
      code,
      verifier: pair.verifier,
      redirectUri,
      clientId: 'centcom-tui',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_grant' });
    await h.app.close();
  });

  it('rejects a code older than 60 seconds', async () => {
    const h = await pkceApp();
    const pair = pkcePair();
    const { code } = await issueCode(h.app, authorizeParams(pair.challenge));
    h.clock.advance(CODE_TTL_MS + 1);
    const res = await exchange(h.app, { code, verifier: pair.verifier, redirectUri });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_grant' });
    await h.app.close();
  });
});
