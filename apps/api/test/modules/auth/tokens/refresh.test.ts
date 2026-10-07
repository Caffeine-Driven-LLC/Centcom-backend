/**
 * Refresh tokens (B017 acceptance 3, 4, 5 and 9, card test refresh.test.ts). The rotation rules
 * as a table; the service over an in-memory store on a moved clock (rotation, reuse revoking the
 * family, 30-day sliding inside 180 days absolute, scope narrowing); and, against a real Postgres
 * 16 (DATABASE_URL, CI's integration job), the Postgres store itself: rotation, reuse, 100
 * parallel refreshes of one token, expiry, devices, and nothing but hashes in the table.
 */
import { createHash } from 'node:crypto';
import { createMemoryRedis } from '@centcom/core';
import type { TokenDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decideRotation,
  hashRefreshToken,
  REFRESH_ABSOLUTE_MS,
  REFRESH_SLIDING_MS,
  RefreshTokenStore,
  TokenService,
  type RefreshGrant,
} from '../../../../src/modules/auth/tokens/index.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from '../../users/helpers.js';
import {
  DAY_MS,
  memoryTokens,
  memoryUser,
  newId,
  seedUser,
  singleKey,
  T0,
  testClock,
} from './helpers.js';

const row = (overrides: Partial<Parameters<typeof decideRotation>[0] & object> = {}) => ({
  revoked_at: null,
  used_at: null,
  client_id: 'centcom-cli' as const,
  expires_at: new Date(T0 + DAY_MS),
  absolute_expires_at: new Date(T0 + 100 * DAY_MS),
  ...overrides,
});

describe('decideRotation', () => {
  const ctx = { nowMs: T0, clientId: 'centcom-cli', deviceRevoked: false };
  it.each([
    ['a fresh token', row(), ctx, 'rotate'],
    ['an unknown token', undefined, ctx, 'invalid'],
    ['a revoked token', row({ revoked_at: new Date(T0) }), ctx, 'invalid'],
    ['a spent token', row({ used_at: new Date(T0) }), ctx, 'reuse'],
    [
      'a spent token from another client',
      row({ used_at: new Date(T0) }),
      { ...ctx, clientId: 'centcom-web' },
      'reuse',
    ],
    [
      'a spent and revoked token',
      row({ used_at: new Date(T0), revoked_at: new Date(T0) }),
      ctx,
      'invalid',
    ],
    ['another client', row(), { ...ctx, clientId: 'centcom-web' }, 'invalid'],
    ['a revoked device', row(), { ...ctx, deviceRevoked: true }, 'invalid'],
    ['the sliding expiry', row({ expires_at: new Date(T0) }), ctx, 'invalid'],
    ['the absolute expiry', row({ absolute_expires_at: new Date(T0) }), ctx, 'invalid'],
  ] as const)('%s: %s', (_label, input, context, decision) => {
    expect(decideRotation(input, context)).toBe(decision);
  });
});

describe('the refresh grant over the in-memory store', () => {
  it('returns a new refresh token and spends the old one; the old one again is reuse and revokes the family (acceptance 3)', async () => {
    const { tokens, store } = memoryTokens();
    const issued = await tokens.issueTokens({
      ...memoryUser(store),
      scopes: ['profile', 'sessions:read'],
    });
    const rotated = await tokens.refresh({
      refreshToken: issued.refresh_token,
      clientId: 'centcom-cli',
    });
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    expect(rotated.scope).toBe('profile sessions:read');
    await expect(
      tokens.refresh({ refreshToken: issued.refresh_token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({
      code: 'refresh_reuse_detected',
      status: 401,
    });
    // The token issued after the spent one is dead too: the family is revoked.
    await expect(
      tokens.refresh({ refreshToken: rotated.refresh_token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('slides 30 days on use and stops at 180 days absolute (acceptance 5, fake clock to day 181)', async () => {
    const clock = testClock();
    const { tokens, store } = memoryTokens({ clock });
    let token = (await tokens.issueTokens({ ...memoryUser(store), scopes: ['profile'] }))
      .refresh_token;
    // Used every 29 days, it lives on past the first 30...
    for (let day = 29; day <= 174; day += 29) {
      clock.advance(29 * DAY_MS);
      token = (await tokens.refresh({ refreshToken: token, clientId: 'centcom-cli' }))
        .refresh_token;
    }
    // ...the last successor (issued day 174) is capped at day 180, not day 204...
    const last = store.rows.get(hashRefreshToken(token));
    expect(last?.expiresAt).toBe(T0 + REFRESH_ABSOLUTE_MS);
    // ...and on day 181 it is refused.
    clock.advance(7 * DAY_MS);
    await expect(
      tokens.refresh({ refreshToken: token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('refuses a token left unused for 30 days', async () => {
    const clock = testClock();
    const { tokens, store } = memoryTokens({ clock });
    const { refresh_token: token } = await tokens.issueTokens({
      ...memoryUser(store),
      scopes: ['profile'],
    });
    clock.advance(REFRESH_SLIDING_MS);
    await expect(
      tokens.refresh({ refreshToken: token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('narrows the access token to a requested subset of the grant, and refuses anything wider', async () => {
    const { tokens, store } = memoryTokens();
    const issued = await tokens.issueTokens({
      ...memoryUser(store),
      scopes: ['profile', 'sessions:read'],
    });
    const narrowed = await tokens.refresh({
      refreshToken: issued.refresh_token,
      clientId: 'centcom-cli',
      scope: 'sessions:read',
    });
    expect(narrowed.scope).toBe('sessions:read');
    expect((await tokens.verifyAccessToken(narrowed.access_token)).scp).toBe('sessions:read');
    // The refresh token keeps the whole grant.
    const again = await tokens.refresh({
      refreshToken: narrowed.refresh_token,
      clientId: 'centcom-cli',
    });
    expect(again.scope).toBe('profile sessions:read');
    await expect(
      tokens.refresh({
        refreshToken: again.refresh_token,
        clientId: 'centcom-cli',
        scope: 'profile admin',
      }),
    ).rejects.toMatchObject({ code: 'invalid_scope' });
  });

  it('issues only for known scopes, valid ids and the user’s own live device', async () => {
    const { tokens, store } = memoryTokens();
    const user = memoryUser(store);
    for (const scopes of [[], ['profile', 'profile'], ['root']]) {
      await expect(tokens.issueTokens({ ...user, scopes })).rejects.toMatchObject({
        code: 'invalid_scope',
      });
    }
    await expect(
      tokens.issueTokens({ ...user, userId: 'bob', scopes: ['profile'] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      tokens.issueTokens({ ...user, workspaceId: 'acme', scopes: ['profile'] }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const stranger = memoryUser(store);
    await expect(
      tokens.issueTokens({ ...user, deviceId: stranger.deviceId, scopes: ['profile'] }),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    await expect(
      tokens.issueTokens({ ...user, deviceId: 'dev_unknown', scopes: ['profile'] }),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    // A device-less client (no dev claim) and a workspace claim.
    const workspaceId = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    const bare = await tokens.issueTokens({
      userId: user.userId,
      deviceId: null,
      workspaceId,
      scopes: ['profile'],
    });
    expect(bare).not.toHaveProperty('device');
    const claims = await tokens.verifyAccessToken(bare.access_token);
    expect(claims).toMatchObject({ wsp: workspaceId, plan: 'free', ent: 0 });
    expect(claims).not.toHaveProperty('dev');
  });

  it('takes plan and ent from the entitlements lookup', async () => {
    const seen: [string, string | null][] = [];
    const { tokens, store } = memoryTokens({
      entitlements: {
        lookup: (userId, workspaceId) => {
          seen.push([userId, workspaceId]);
          return Promise.resolve({ plan: 'team', ent: 12 });
        },
      },
    });
    const user = memoryUser(store);
    const issued = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    expect(await tokens.verifyAccessToken(issued.access_token)).toMatchObject({
      plan: 'team',
      ent: 12,
    });
    expect(seen).toEqual([[user.userId, null]]);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the Postgres store on Postgres 16', () => {
  let t: TestDatabase;
  let db: Kysely<TokenDatabase>;
  beforeAll(async () => {
    t = await migratedDatabase(30);
    db = t.db as unknown as Kysely<TokenDatabase>;
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  const grantFor = async (overrides: Partial<RefreshGrant> = {}): Promise<RefreshGrant> => ({
    ...(await seedUser(t.db)),
    clientId: 'centcom-cli',
    scope: 'profile',
    workspaceId: null,
    ...overrides,
  });

  it('rotates, and treats the spent token as reuse that revokes the family (acceptance 3)', async () => {
    const clock = testClock();
    const store = new RefreshTokenStore({ db, now: clock.now });
    const first = await store.issue(await grantFor());
    clock.advance(1_000);
    const second = await store.rotate(first, 'centcom-cli');
    expect(second.grant.scope).toBe('profile');
    await expect(store.rotate(first, 'centcom-cli')).rejects.toMatchObject({
      code: 'refresh_reuse_detected',
    });
    await expect(store.rotate(second.token, 'centcom-cli')).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    const rows = await db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('family_id', '=', second.familyId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    const child = rows.find((r) => r.parent_hash !== null);
    expect(child?.parent_hash).toBe(hashRefreshToken(first));
  });

  it('lets exactly one of 100 parallel refreshes of one token through, issuing nothing for the rest (acceptance 4)', async () => {
    const store = new RefreshTokenStore({ db, now: Date.now });
    const token = await store.issue(await grantFor());
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => store.rotate(token, 'centcom-cli')),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const codes = lost.map((r) => (r.reason as { code?: string }).code);
    // The first loser finds the token spent and revokes the family (reuse). Losers that take the
    // row lock after that commit find it spent and revoked, which decideRotation answers with
    // invalid_grant ("a spent and revoked token" above). How many land on each side is timing.
    expect(codes).toContain('refresh_reuse_detected');
    for (const code of codes) expect(['refresh_reuse_detected', 'invalid_grant']).toContain(code);
    const familyId = won[0]?.status === 'fulfilled' ? won[0].value.familyId : '';
    expect(
      await db
        .selectFrom('refresh_tokens')
        .select('token_hash')
        .where('family_id', '=', familyId)
        .execute(),
    ).toHaveLength(2);
  }, 60_000);

  it('slides 30 days and refuses at day 181 (acceptance 5)', async () => {
    const clock = testClock();
    const store = new RefreshTokenStore({ db, now: clock.now });
    let token = await store.issue(await grantFor());
    for (let i = 0; i < 6; i++) {
      clock.advance(29 * DAY_MS);
      token = (await store.rotate(token, 'centcom-cli')).token;
    }
    const last = await db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hashRefreshToken(token))
      .executeTakeFirstOrThrow();
    expect(last.expires_at.getTime()).toBe(T0 + REFRESH_ABSOLUTE_MS);
    expect(last.absolute_expires_at.getTime()).toBe(T0 + REFRESH_ABSOLUTE_MS);
    clock.advance(7 * DAY_MS); // day 181
    await expect(store.rotate(token, 'centcom-cli')).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('refuses another client and a revoked device; revokes by token for its owner only', async () => {
    const store = new RefreshTokenStore({ db, now: Date.now });
    const grant = await grantFor();
    const token = await store.issue(grant);
    await expect(store.rotate(token, 'centcom-web')).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(await store.revokeByToken(token, newId('usr'))).toBe(false);
    const other = await store.issue(grant);
    expect(await store.revokeByToken(other, grant.userId)).toBe(true);
    await expect(store.rotate(other, 'centcom-cli')).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    // Revoking the device ends the rest and marks the device.
    await store.revokeDevice(grant.deviceId ?? '');
    await expect(store.rotate(token, 'centcom-cli')).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(await store.device(grant.deviceId ?? '')).toEqual({
      userId: grant.userId,
      revoked: true,
    });
    expect(await store.device('dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).toBeUndefined();
  });

  it('stores refresh tokens only as SHA-256 hashes (acceptance 9)', async () => {
    const store = new RefreshTokenStore({ db, now: Date.now });
    const token = await store.issue(await grantFor());
    const next = (await store.rotate(token, 'centcom-cli')).token;
    const dump = JSON.stringify(await db.selectFrom('refresh_tokens').selectAll().execute());
    for (const plain of [token, next]) {
      expect(dump).not.toContain(plain);
      expect(dump).toContain(createHash('sha256').update(plain).digest('hex'));
    }
  });

  it('runs the whole flow through the service against Postgres', async () => {
    const clock = testClock(Date.now());
    const tokens = new TokenService({
      db,
      keys: singleKey(),
      kv: createMemoryRedis(clock.now).kv,
      now: clock.now,
    });
    const user = await seedUser(t.db);
    const issued = await tokens.issueTokens({ ...user, scopes: ['profile'] });
    expect((await tokens.verifyAccessToken(issued.access_token)).dev).toBe(user.deviceId);
    const rotated = await tokens.refresh({
      refreshToken: issued.refresh_token,
      clientId: 'centcom-cli',
    });
    await tokens.revokeDevice(user.deviceId);
    await expect(tokens.verifyAccessToken(rotated.access_token)).rejects.toMatchObject({
      code: 'device_revoked',
    });
    await expect(tokens.issueTokens({ ...user, scopes: ['profile'] })).rejects.toMatchObject({
      code: 'device_revoked',
    });
  });
});
