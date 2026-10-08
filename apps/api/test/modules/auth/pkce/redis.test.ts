/**
 * Codes and login sessions on a real Redis 7 (B018 with B009's `createRedis`), when REDIS_URL is
 * set (CI's integration job): a code claimed by exactly one of many concurrent callers, its 60 s
 * TTL set on the key, and a login session that survives a round trip and ends on logout.
 */
import {
  createRedis,
  defineConfig,
  keyPrefixFor,
  Secret,
  z,
  type RedisBackend,
} from '@centcom/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthorizationCodeStore,
  CODE_TTL_MS,
} from '../../../../src/modules/auth/pkce/code-store.js';
import { createLoginSessions } from '../../../../src/modules/auth/web-session/store.js';
import { newId, pkcePair, recordingKv } from './helpers.js';

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

describe.skipIf(REDIS_URL === undefined)('on a real Redis', () => {
  let redis: RedisBackend;

  beforeAll(async () => {
    redis = createRedis({ url: new Secret(REDIS_URL ?? ''), keyPrefix: keyPrefixFor('test') });
    await redis.ping();
  });

  afterAll(async () => {
    await redis.close();
  });

  it('lets exactly one of many concurrent callers claim a code', async () => {
    const kv = recordingKv(redis.kv);
    const store = new AuthorizationCodeStore({ kv });
    const code = await store.issue(
      {
        clientId: 'centcom-cli',
        redirectUri: 'http://127.0.0.1:5000/callback',
        codeChallenge: pkcePair().challenge,
        userId: newId('usr'),
        scope: 'profile',
      },
      Date.now(),
    );
    const ttl = await redis.kv.ttl(kv.writes[0]?.key ?? '');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CODE_TTL_MS);
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => store.claim(code, Date.now())),
    );
    expect(claims.filter((c) => c.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((c) => c.kind === 'replayed')).toHaveLength(9);
  });

  it('keeps a login session and ends it', async () => {
    const sessions = createLoginSessions({ kv: redis.kv });
    const headers: Record<string, unknown> = {};
    const reply = {
      request: { headers: {} },
      header(name: string, value: unknown) {
        headers[name] = value;
        return this;
      },
    };
    const userId = newId('usr');
    await sessions.establishLoginSession(reply as never, userId);
    const cookie = String(headers['set-cookie']).split(';')[0] ?? '';
    const request = { headers: { cookie } };
    expect(await sessions.getLoginSession(request as never)).toEqual({ userId });
    await sessions.endLoginSession(request as never, reply as never);
    expect(await sessions.getLoginSession(request as never)).toBeNull();
  });
});
