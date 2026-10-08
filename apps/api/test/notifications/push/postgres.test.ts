/**
 * The push registry on Postgres 16 (B064 acceptance 2, 3, 5 and 8; DATABASE_URL, CI's integration
 * job): one row for a repeated endpoint (also under 10 concurrent registrations), 409 for an 11th,
 * devices only the caller's own, delete by owner only, the endpoint/token and keys sealed in the
 * row (a dump holds neither) and opened again for sending, and failure counting (the fifth in a
 * row within 24 h deletes; a run restarts after 24 h; a success resets it).
 */
import { createHash, randomBytes } from 'node:crypto';
import { isAppError } from '@centcom/core';
import type { CoreDatabase, PushDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { PushRegistry } from '../../../src/modules/notifications/push/registry.js';
import { ADMIN_URL, migratedDatabase, newId } from '../../modules/users/helpers.js';
import { browserKeys, pushKey } from './helpers.js';

async function newUser(db: Kysely<CoreDatabase>): Promise<string> {
  const id = newId('usr');
  await db
    .insertInto('users')
    .values({ id, email: `${id.toLowerCase()}@example.test`, display_name: 'Push Tester' })
    .execute();
  return id;
}

async function newDevice(db: Kysely<CoreDatabase>, userId: string): Promise<string> {
  const id = newId('dev');
  await db
    .insertInto('devices')
    .values({
      id,
      user_id: userId,
      name: 'Phone',
      platform: 'other',
      x25519_pub: randomBytes(32).toString('base64url'),
      ed25519_pub: randomBytes(32).toString('base64url'),
      fingerprint: 'ABCD-EFGH-JKLM',
    })
    .execute();
  return id;
}

const webSubscription = () => {
  const keys = browserKeys();
  return {
    kind: 'web_push' as const,
    token: `https://fcm.googleapis.com/fcm/send/${randomBytes(16).toString('hex')}`,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
};

describe.runIf(ADMIN_URL !== undefined)('push subscriptions on Postgres 16', () => {
  it('registers, de-duplicates, caps, checks devices and deletes by owner', async () => {
    const t = await migratedDatabase(15);
    try {
      const registry = new PushRegistry({
        db: t.db as unknown as Kysely<PushDatabase>,
        key: pushKey(),
      });
      const alice = await newUser(t.db);
      const bob = await newUser(t.db);
      const sub = webSubscription();
      const first = await registry.register(alice, sub);
      expect(first.created).toBe(true);
      const again = await registry.register(alice, sub);
      expect(again).toEqual({ subscription: first.subscription, created: false });

      const racing = webSubscription();
      const raced = await Promise.all(
        Array.from({ length: 10 }, () => registry.register(alice, racing)),
      );
      expect(new Set(raced.map((r) => r.subscription.id)).size).toBe(1);
      expect(raced.filter((r) => r.created)).toHaveLength(1);

      for (let i = 0; i < 8; i += 1)
        await registry.register(alice, { kind: 'apns', token: randomBytes(32).toString('hex') });
      const eleventh = await registry
        .register(alice, webSubscription())
        .catch((err: unknown) => err);
      expect(isAppError(eleventh) && eleventh.code).toBe('conflict');
      const count = await (t.db as unknown as Kysely<PushDatabase>)
        .selectFrom('push_subscriptions')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', alice)
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(10);

      // Devices: the caller's live device only.
      const bobsDevice = await newDevice(t.db, bob);
      const wrong = await registry
        .register(bob, { kind: 'fcm', token: 'fcm-token-1', device: await newDevice(t.db, alice) })
        .catch((err: unknown) => err);
      expect(isAppError(wrong) && wrong.code).toBe('validation_failed');
      const withDevice = await registry.register(bob, {
        kind: 'fcm',
        token: 'fcm-token-2',
        device: bobsDevice,
      });
      expect(withDevice.subscription.device).toBe(bobsDevice);

      // Delete: the owner only, once.
      expect(await registry.remove(bob, first.subscription.id)).toBe(false);
      expect(await registry.remove(alice, first.subscription.id)).toBe(true);
      expect(await registry.remove(alice, first.subscription.id)).toBe(false);
      expect(await registry.remove(alice, 'psh_nope')).toBe(false);
    } finally {
      await t.drop();
    }
  });

  it('keeps endpoints, tokens and keys sealed, and opens them for sending', async () => {
    const t = await migratedDatabase(5);
    try {
      const registry = new PushRegistry({
        db: t.db as unknown as Kysely<PushDatabase>,
        key: pushKey(),
      });
      const alice = await newUser(t.db);
      const sub = webSubscription();
      const { subscription } = await registry.register(alice, sub);
      const dump = await sql<Record<string, unknown>>`select * from push_subscriptions`.execute(
        t.db,
      );
      const text = JSON.stringify(dump.rows);
      for (const secret of [sub.token, sub.keys.p256dh, sub.keys.auth])
        expect(text).not.toContain(secret);
      expect(Buffer.from(dump.rows[0]?.['token_hash'] as Buffer)).toEqual(
        createHash('sha256').update(sub.token).digest(),
      );
      expect(await registry.targets(alice)).toEqual([
        { id: subscription.id, kind: 'web_push', token: sub.token, keys: sub.keys },
      ]);
      expect(await registry.targets(alice, [])).toEqual([]);
      expect(await registry.targets(alice, ['psh_01JA3Z8K2M5N7P9Q0R1S2T3V4W'])).toEqual([]);
      // Another key cannot open them: the row is skipped, not exposed.
      const other = new PushRegistry({
        db: t.db as unknown as Kysely<PushDatabase>,
        key: pushKey(),
      });
      expect(await other.targets(alice)).toEqual([]);
    } finally {
      await t.drop();
    }
  });

  it('deletes on the fifth failure in a row within 24 h, restarts after 24 h, resets on success', async () => {
    const t = await migratedDatabase(5);
    try {
      const registry = new PushRegistry({
        db: t.db as unknown as Kysely<PushDatabase>,
        key: pushKey(),
      });
      const alice = await newUser(t.db);
      const { subscription: a } = await registry.register(alice, {
        kind: 'apns',
        token: 'aa'.repeat(32),
      });
      const { subscription: b } = await registry.register(alice, {
        kind: 'apns',
        token: 'bb'.repeat(32),
      });
      const { subscription: c } = await registry.register(alice, {
        kind: 'apns',
        token: 'cc'.repeat(32),
      });
      const t0 = Date.UTC(2026, 9, 8, 12, 0, 0);
      const hour = 3_600_000;

      for (let i = 0; i < 4; i += 1)
        expect(await registry.recordFailure(a.id, new Date(t0 + i * hour))).toBe(false);
      expect(await registry.recordFailure(a.id, new Date(t0 + 23 * hour))).toBe(true);

      for (let i = 0; i < 4; i += 1)
        expect(await registry.recordFailure(b.id, new Date(t0 + i * hour))).toBe(false);
      expect(await registry.recordFailure(b.id, new Date(t0 + 25 * hour))).toBe(false);

      for (let i = 0; i < 4; i += 1) await registry.recordFailure(c.id, new Date(t0 + i * hour));
      await registry.recordSuccess(c.id);
      expect(await registry.recordFailure(c.id, new Date(t0 + 5 * hour))).toBe(false);

      const left = (await registry.targets(alice)).map((s) => s.id).sort();
      expect(left).toEqual([b.id, c.id].sort());
      await registry.delete(b.id);
      expect((await registry.targets(alice)).map((s) => s.id)).toEqual([c.id]);
    } finally {
      await t.drop();
    }
  });
});
