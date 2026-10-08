/**
 * The device repository on Postgres 16 (B020; DATABASE_URL, CI's integration job): insert and read
 * back with the CT-CRYPTO fingerprint, the owner's pages newest first with a working cursor,
 * revocation once and only by the owner (also under 10 concurrent calls), the conditional touch,
 * shared sessions (left members included), and B017's refresh rotation refusing a revoked
 * device's token.
 */
import { randomBytes } from 'node:crypto';
import { createMemoryRedis } from '@centcom/core';
import { createDeviceRepo, type CoreDatabase, type TokenDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { TokenService } from '../../../src/modules/auth/tokens/index.js';
import { deviceStoreFromDb } from '../../../src/modules/devices/repo.js';
import { DeviceService } from '../../../src/modules/devices/service.js';
import { singleKey, testClock } from '../auth/tokens/helpers.js';
import { ADMIN_URL, migratedDatabase } from '../users/helpers.js';
import { KEYS, newId } from './helpers.js';

async function newUser(db: Kysely<CoreDatabase>): Promise<string> {
  const id = newId('usr');
  await db
    .insertInto('users')
    .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'Device Tester' })
    .execute();
  return id;
}

const key = (): string => randomBytes(32).toString('base64url');

describe.runIf(ADMIN_URL !== undefined)('devices on Postgres 16', () => {
  it('registers, lists, revokes once, touches and finds shared sessions', async () => {
    const t = await migratedDatabase(12);
    try {
      const clock = testClock();
      const redis = createMemoryRedis(clock.now);
      const tokens = new TokenService({
        db: t.db as unknown as Kysely<TokenDatabase>,
        keys: singleKey(),
        kv: redis.kv,
        now: clock.now,
      });
      const store = deviceStoreFromDb(t.db);
      const devices = new DeviceService({ store, tokens, pubsub: redis.pubsub, now: clock.now });
      const alice = await newUser(t.db);
      const bob = await newUser(t.db);

      const x25519 = Buffer.alloc(32, 1).toString('base64url');
      const ed25519 = Buffer.alloc(32, 2).toString('base64url');
      const first = await devices.registerDevice({
        userId: alice,
        name: 'A1',
        platform: 'linux',
        x25519,
        ed25519,
      });
      expect(first.key_fingerprint).toBe('GC3A-B6Y7-BTAL');
      const ids = [first.id];
      for (const name of ['A2', 'A3']) {
        ids.unshift(
          (
            await devices.registerDevice({
              userId: alice,
              name,
              platform: 'web',
              x25519: key(),
              ed25519: key(),
            })
          ).id,
        );
      }
      const bobs = await devices.registerDevice({
        userId: bob,
        name: 'B1',
        platform: 'macos',
        x25519: key(),
        ed25519: key(),
      });

      // Pages: newest first (ties broken by id), cursor continues.
      const params = { limit: 2, sort: 'created', filterHash: 'h', keys: KEYS, now: clock.now() };
      const page1 = await devices.list(alice, params);
      expect(page1.data).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      const page2 = await devices.list(alice, { ...params, cursor: page1.next_cursor ?? '' });
      const listed = [...page1.data, ...page2.data].map((d) => d.id);
      expect(new Set(listed)).toEqual(new Set(ids));
      expect(listed).not.toContain(bobs.id);
      expect(page2.has_more).toBe(false);
      expect(Object.keys(page1.data[0] ?? {})).not.toContain('x25519_pub');

      // Revocation: once, only by the owner, under concurrency.
      const repo = createDeviceRepo(t.db);
      const at = new Date(clock.now());
      expect(await repo.markRevoked(first.id, bob, at)).toBe(false);
      const racers = await Promise.all(
        Array.from({ length: 10 }, () => repo.markRevoked(first.id, alice, at)),
      );
      expect(racers.filter(Boolean)).toHaveLength(1);
      expect((await repo.findById(first.id))?.revoked_at).toEqual(at);

      // Touch: once per interval, never on a revoked device.
      const live = ids[0] ?? '';
      const t0 = new Date(clock.now());
      expect(await repo.touch(live, t0, 300_000)).toBe(true);
      expect(await repo.touch(live, new Date(t0.getTime() + 299_999), 300_000)).toBe(false);
      expect(await repo.touch(live, new Date(t0.getTime() + 300_000), 300_000)).toBe(true);
      expect(await repo.touch(first.id, new Date(t0.getTime() + 900_000), 300_000)).toBe(false);

      // Shared sessions: a row for both users in one session, even after one left.
      expect(await repo.shareSession(bob, alice)).toBe(false);
      const session = newId('ses');
      await t.db
        .insertInto('sessions')
        .values({ id: session, name: 'Pairing', region: 'eu', created_by: alice })
        .execute();
      await t.db
        .insertInto('session_members')
        .values([
          {
            id: newId('mem'),
            session_id: session,
            user_id: alice,
            device_id: live,
            role: 'host',
            slot: 0,
          },
          {
            id: newId('mem'),
            session_id: session,
            user_id: bob,
            device_id: bobs.id,
            role: 'viewer',
            slot: 1,
            left_at: new Date(),
          },
        ])
        .execute();
      expect(await repo.shareSession(bob, alice)).toBe(true);
      expect(await devices.keys(bob, first.id)).toMatchObject({ device: first.id, revoked: true });
    } finally {
      await t.drop();
    }
  });

  it("makes B017 refuse a revoked device's refresh token", async () => {
    const t = await migratedDatabase(5);
    try {
      const clock = testClock();
      const redis = createMemoryRedis(clock.now);
      const tokens = new TokenService({
        db: t.db as unknown as Kysely<TokenDatabase>,
        keys: singleKey(),
        kv: redis.kv,
        now: clock.now,
      });
      const devices = new DeviceService({
        store: deviceStoreFromDb(t.db),
        tokens,
        pubsub: redis.pubsub,
        now: clock.now,
      });
      const alice = await newUser(t.db);
      const device = await devices.registerDevice({
        userId: alice,
        name: 'CLI',
        platform: 'linux',
        x25519: key(),
        ed25519: key(),
      });
      const issued = await tokens.issueTokens({
        userId: alice,
        deviceId: device.id,
        scopes: ['profile'],
      });
      await devices.revokeDevice(alice, device.id);
      await expect(
        tokens.refresh({ refreshToken: issued.refresh_token, clientId: 'centcom-cli' }),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      await expect(tokens.verifyAccessToken(issued.access_token)).rejects.toMatchObject({
        code: 'device_revoked',
      });
    } finally {
      await t.drop();
    }
  });
});
