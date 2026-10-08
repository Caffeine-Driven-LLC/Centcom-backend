/**
 * The device flow on Postgres 16 (B016; DATABASE_URL, CI's integration job): the migration's
 * constraints, the Postgres store under the same flow as the in-memory one, the device_code only
 * as a hash in a dump of the table (acceptance 6), exactly one of 20 concurrent polls getting the
 * tokens (failure mode), and a failed token issue leaving no device and an approved grant behind
 * (guardrail).
 */
import { createHash } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import type { CoreDatabase, DeviceGrantDatabase, TokenDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDeviceGrantHandler } from '../../../../src/modules/auth/device/grant-handler.js';
import { deviceFingerprint } from '../../../../src/modules/auth/device/keys.js';
import { DeviceGrantService } from '../../../../src/modules/auth/device/service.js';
import { createDeviceGrantStore } from '../../../../src/modules/auth/device/store.js';
import { TokenService } from '../../../../src/modules/auth/tokens/index.js';
import { ADMIN_URL, migratedDatabase } from '../../users/helpers.js';
import { singleKey, testClock } from '../tokens/helpers.js';
import { startBody } from './helpers.js';

const POLL = {
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  client_id: 'centcom-cli',
} as const;

async function newUser(db: Kysely<CoreDatabase>): Promise<string> {
  const id = newId('usr');
  await db
    .insertInto('users')
    .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'Device Tester' })
    .execute();
  return id;
}

/** The test database with the device flow's tables. */
const grants = (db: Kysely<CoreDatabase>): Kysely<DeviceGrantDatabase> =>
  db as unknown as Kysely<DeviceGrantDatabase>;

/** The flow's parts on a migrated database. */
function parts(db: Kysely<CoreDatabase>) {
  const clock = testClock();
  const redis = createMemoryRedis(clock.now);
  const store = createDeviceGrantStore(grants(db));
  const tokens = new TokenService({
    db: db as unknown as Kysely<TokenDatabase>,
    keys: singleKey(),
    kv: redis.kv,
    now: clock.now,
  });
  const service = new DeviceGrantService({ store, kv: redis.kv, now: clock.now });
  const poll = createDeviceGrantHandler({ store, tokens, now: clock.now });
  return { clock, store, tokens, service, poll };
}

const codeOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'tokens',
    (err: unknown) => (err as { code?: unknown }).code,
  );

describe.runIf(ADMIN_URL !== undefined)('the device flow on Postgres 16', () => {
  it('runs start, pending, slow_down, approve, tokens and single use', async () => {
    const t = await migratedDatabase(5);
    try {
      const { clock, service, poll, tokens } = parts(t.db);
      const userId = await newUser(t.db);
      const started = await service.start(startBody(), {
        userAgent: 'centcom-cli/1.4.2 (contract/1.0.0; darwin-arm64; node/22.9.0)',
      });
      const request = { ...POLL, device_code: started.device_code };

      await expect(codeOf(poll(request))).resolves.toBe('authorization_pending');
      clock.advance(1_000);
      await expect(codeOf(poll(request))).resolves.toBe('slow_down');
      const stored = await grants(t.db)
        .selectFrom('device_grants')
        .select(['interval_s', 'status'])
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({ interval_s: 10, status: 'pending' });

      const shown = await service.lookupUserCode(started.user_code, { userId, ip: null });
      expect(shown).toMatchObject({ userCode: started.user_code, platform: 'macos' });
      await service.approveDeviceGrant(started.user_code, userId);
      const issued = await poll(request);
      expect(issued).toMatchObject({ user: userId, device: expect.stringMatching(/^dev_/) });
      await expect(tokens.verifyAccessToken(issued.access_token)).resolves.toMatchObject({
        dev: issued.device,
      });
      await expect(codeOf(poll(request))).resolves.toBe('expired_token');

      const device = await t.db
        .selectFrom('devices')
        .selectAll()
        .where('id', '=', issued.device ?? '')
        .executeTakeFirstOrThrow();
      expect(device).toMatchObject({
        user_id: userId,
        name: 'build-box',
        platform: 'macos',
        fingerprint: deviceFingerprint({ x25519: device.x25519_pub, ed25519: device.ed25519_pub }),
        revoked_at: null,
      });
      const refresh = await grants(t.db)
        .selectFrom('refresh_tokens')
        .select(['device_id', 'client_id'])
        .execute();
      expect(refresh).toEqual([{ device_id: issued.device, client_id: 'centcom-cli' }]);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('keeps the device_code only as its hash: a dump of the table never holds it (acceptance 6)', async () => {
    const t = await migratedDatabase(5);
    try {
      const { service } = parts(t.db);
      const codes: string[] = [];
      for (let i = 0; i < 5; i++) codes.push((await service.start(startBody())).device_code);
      const { rows } = await sql<Record<string, unknown>>`select * from device_grants`.execute(
        t.db,
      );
      const dump = JSON.stringify(rows);
      for (const code of codes) {
        expect(dump).not.toContain(code);
        expect(dump).toContain(createHash('sha256').update(code).digest('hex'));
      }
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('gives the tokens to exactly one of 20 concurrent polls (failure mode)', async () => {
    const t = await migratedDatabase(25);
    try {
      const { service, poll } = parts(t.db);
      const userId = await newUser(t.db);
      const started = await service.start(startBody());
      await service.approveDeviceGrant(started.user_code, userId);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          codeOf(poll({ ...POLL, device_code: started.device_code })),
        ),
      );
      expect(results.filter((r) => r === 'tokens')).toHaveLength(1);
      expect(results.filter((r) => r !== 'tokens')).toEqual(Array(19).fill('expired_token'));
      const devices = await t.db.selectFrom('devices').select('id').execute();
      expect(devices).toHaveLength(1);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('leaves no device and keeps the approval when issuing fails; the next poll succeeds (guardrail)', async () => {
    const t = await migratedDatabase(5);
    try {
      const { clock, store, tokens, service } = parts(t.db);
      const userId = await newUser(t.db);
      const started = await service.start(startBody());
      await service.approveDeviceGrant(started.user_code, userId);
      let fail = true;
      const flaky = createDeviceGrantHandler({
        store,
        now: clock.now,
        tokens: {
          issueTokens: async (input, tx) => {
            // The refresh token is written first, then the failure: both must roll back.
            const issued = await tokens.issueTokens(input, tx);
            if (fail) throw new Error('signing failed');
            return issued;
          },
        },
      });
      const request = { ...POLL, device_code: started.device_code };
      await expect(flaky(request)).rejects.toThrow('signing failed');
      expect(await t.db.selectFrom('devices').select('id').execute()).toEqual([]);
      expect(
        await grants(t.db).selectFrom('refresh_tokens').select('token_hash').execute(),
      ).toEqual([]);
      const grant = await grants(t.db)
        .selectFrom('device_grants')
        .select(['status', 'device_id'])
        .executeTakeFirstOrThrow();
      expect(grant).toEqual({ status: 'approved', device_id: null });

      fail = false;
      await expect(flaky(request)).resolves.toMatchObject({ user: userId });
      expect(await t.db.selectFrom('devices').select('id').execute()).toHaveLength(1);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('hands out a user code to one pending grant at a time, and denies or approves it once', async () => {
    const t = await migratedDatabase(5);
    try {
      const { store } = parts(t.db);
      const userId = await newUser(t.db);
      const grant = (hash: string) => ({
        deviceCodeHash: createHash('sha256').update(hash).digest('hex'),
        userCode: 'ABCDEFGH',
        clientId: 'centcom-cli' as const,
        scope: 'profile',
        deviceName: 'box',
        platform: 'linux' as const,
        x25519Pub: 'A'.repeat(42) + 'E',
        ed25519Pub: 'B'.repeat(42) + 'E',
        intervalS: 5,
        expiresAt: new Date(Date.now() + 600_000),
      });
      expect(await store.insert(grant('a'))).toBe('inserted');
      expect(await store.insert(grant('b'))).toBe('user_code_taken');
      const now = new Date();
      expect(await store.decide('ABCDEFGH', userId, 'denied', now)).toBe(true);
      expect(await store.decide('ABCDEFGH', userId, 'approved', now)).toBe(false);
      // Decided: the code is free again.
      expect(await store.insert(grant('b'))).toBe('inserted');
      // A duplicate device_code hash is not a user-code clash: it is an error.
      await expect(store.insert({ ...grant('b'), userCode: 'ZZZZZZZZ' })).rejects.toThrow();
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('refuses rows that break the table rules', async () => {
    const t = await migratedDatabase(5);
    try {
      const base = {
        device_code_hash: 'a'.repeat(64),
        user_code: 'ABCDEFGH',
        client_id: 'centcom-cli',
        scope: 'profile',
        device_name: 'box',
        platform: 'linux',
        x25519_pub: 'A'.repeat(43),
        ed25519_pub: 'B'.repeat(43),
        expires_at: new Date(),
      };
      const bad: Record<string, unknown>[] = [
        { device_code_hash: 'not-a-hash' },
        { user_code: 'ABCD-EFGH' },
        { user_code: 'ABCDEFGI' },
        { client_id: 'centcom-desktop' },
        { platform: 'beos' },
        { status: 'approved' },
        { interval_s: 4 },
        { interval_s: 61 },
        { x25519_pub: 'A'.repeat(42) },
      ];
      for (const change of bad) {
        await expect(
          grants(t.db)
            .insertInto('device_grants')
            // Values the types forbid, on purpose: the database must refuse them too.
            .values({ ...base, ...change } as never)
            .execute(),
          JSON.stringify(change),
        ).rejects.toThrow();
      }
      await grants(t.db)
        .insertInto('device_grants')
        .values({ ...base, client_id: 'centcom-cli', platform: 'linux' })
        .execute();
    } finally {
      await t.drop();
    }
  }, 60_000);
});
