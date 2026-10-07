/**
 * API keys on Postgres 16 (B019; DATABASE_URL, CI's integration job): the store's SQL under the
 * service, the limit under 20 concurrent creates against the real row lock (failure mode), the
 * row dump free of key material (acceptance 1), `last_used_at` written once between two "API
 * processes", purge removing a workspace's keys, and the table's rules.
 */
import { createHash } from 'node:crypto';
import { newId } from '@centcom/contracts';
import type { ApiKeyDatabase, CoreDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createApiKeyAuthenticator } from '../../../src/modules/apikeys/authenticator.js';
import { hashApiKey } from '../../../src/modules/apikeys/generate.js';
import { createApiKeyStore } from '../../../src/modules/apikeys/repo.js';
import { ApiKeyService } from '../../../src/modules/apikeys/service.js';
import { ADMIN_URL, migratedDatabase } from '../users/helpers.js';
import { KEYS, limitsOf, PEPPER } from './helpers.js';

const keysDb = (db: Kysely<CoreDatabase>): Kysely<ApiKeyDatabase> =>
  db as unknown as Kysely<ApiKeyDatabase>;

/** A user and a workspace they belong to. */
async function arrange(db: Kysely<CoreDatabase>): Promise<{ userId: string; workspaceId: string }> {
  const userId = newId('usr');
  const workspaceId = newId('wsp');
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: `${userId.toLowerCase()}@example.test`,
      display_name: 'Key Maker',
    })
    .execute();
  await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      name: 'Acme',
      slug: `acme-${workspaceId.slice(-8).toLowerCase()}`,
      created_by: userId,
    })
    .execute();
  return { userId, workspaceId };
}

const noAudit = { audit: () => Promise.resolve('aud_01JA3Z8K2M5N7P9Q0R1S2T3V4W') };
const creator = (userId: string) => ({
  userId,
  scopes: ['workspaces:read', 'workspaces:write'],
  may: () => Promise.resolve(true),
});
const input = (workspaceId: string) => ({
  workspaceId,
  name: 'CI',
  scopes: ['workspaces:read'],
  mode: 'live' as const,
  expiresAt: null,
});
const params = (filterHash = 'sha256:x') => ({
  limit: 2,
  sort: 'created',
  filterHash,
  keys: KEYS,
  now: Date.now(),
});

describe.runIf(ADMIN_URL !== undefined)('API keys on Postgres 16', () => {
  it('creates, finds by hash, lists in pages, revokes and rotates', async () => {
    const t = await migratedDatabase(5);
    try {
      const store = createApiKeyStore(keysDb(t.db));
      const service = new ApiKeyService({ store, pepper: PEPPER, limits: limitsOf(null) });
      const { userId, workspaceId } = await arrange(t.db);
      const made = [];
      for (let i = 0; i < 3; i++)
        made.push(await service.create(input(workspaceId), creator(userId), noAudit));
      const found = await store.findByHash(hashApiKey(made[0]?.key ?? '', PEPPER));
      expect(found).toMatchObject({
        id: made[0]?.record.id,
        workspaceLive: true,
        scopes: ['workspaces:read'],
      });

      const first = await store.list({ workspaceId }, params());
      expect(first.data.map((k) => k.id)).toEqual([made[2]?.record.id, made[1]?.record.id]);
      const second = await store.list(
        { workspaceId },
        { ...params(), cursor: first.next_cursor ?? '' },
      );
      expect(second).toMatchObject({ has_more: false, data: [{ id: made[0]?.record.id }] });

      await service.revoke(made[0]?.record.id ?? '', noAudit);
      expect((await store.findById(made[0]?.record.id ?? ''))?.revokedAt).toBeInstanceOf(Date);
      const rotated = await service.rotateApiKey(
        made[1]?.record.id ?? '',
        { type: 'system', id: 'admin-console' },
        noAudit,
      );
      expect(await store.findByHash(hashApiKey(rotated.key, PEPPER))).toMatchObject({
        name: 'CI',
        revokedAt: null,
      });
      expect((await store.findById(made[1]?.record.id ?? ''))?.revokedAt).toBeInstanceOf(Date);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('never passes the limit under 20 concurrent creates (failure mode)', async () => {
    const t = await migratedDatabase(25);
    try {
      const service = new ApiKeyService({
        store: createApiKeyStore(keysDb(t.db)),
        pepper: PEPPER,
        limits: limitsOf(5),
      });
      const { userId, workspaceId } = await arrange(t.db);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          service.create(input(workspaceId), creator(userId), noAudit),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused.map((r) => (r.reason as { code?: string }).code)).toEqual(
        Array(15).fill('quota_exceeded'),
      );
      const { rows } = await sql<{ n: string }>`select count(*) as n from api_keys`.execute(t.db);
      expect(rows[0]?.n).toBe('5');
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('stores neither a key nor its unpeppered hash (acceptance 1)', async () => {
    const t = await migratedDatabase(5);
    try {
      const service = new ApiKeyService({
        store: createApiKeyStore(keysDb(t.db)),
        pepper: PEPPER,
        limits: limitsOf(null),
      });
      const { userId, workspaceId } = await arrange(t.db);
      const { key } = await service.create(input(workspaceId), creator(userId), noAudit);
      const { rows } = await sql<Record<string, unknown>>`select * from api_keys`.execute(t.db);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(key);
      expect(dump).not.toContain(key.slice(12));
      expect(dump).not.toContain(createHash('sha256').update(key).digest('hex'));
      expect(dump).toContain(hashApiKey(key, PEPPER));
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('writes last_used_at once a minute between two API processes', async () => {
    const t = await migratedDatabase(5);
    try {
      const store = createApiKeyStore(keysDb(t.db));
      const service = new ApiKeyService({ store, pepper: PEPPER, limits: limitsOf(null) });
      const { userId, workspaceId } = await arrange(t.db);
      const { key, record } = await service.create(input(workspaceId), creator(userId), noAudit);
      const at = Date.now();
      const a = createApiKeyAuthenticator({ store, pepper: PEPPER, now: () => at });
      const b = createApiKeyAuthenticator({ store, pepper: PEPPER, now: () => at + 1_000 });
      await a.resolve(key);
      await a.settled();
      await b.resolve(key);
      await b.settled();
      const row = await keysDb(t.db)
        .selectFrom('api_keys')
        .select('last_used_at')
        .where('id', '=', record.id)
        .executeTakeFirstOrThrow();
      expect(row.last_used_at?.getTime()).toBe(at);
      expect(await store.touch(record.id, new Date(at + 61_000), 60_000)).toBe(true);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('loses a deleted workspace’s keys from lookups, and a purge removes them', async () => {
    const t = await migratedDatabase(5);
    try {
      const store = createApiKeyStore(keysDb(t.db));
      const service = new ApiKeyService({ store, pepper: PEPPER, limits: limitsOf(null) });
      const { userId, workspaceId } = await arrange(t.db);
      const { key, record } = await service.create(input(workspaceId), creator(userId), noAudit);
      await t.db
        .updateTable('workspaces')
        .set({ deleted_at: new Date() })
        .where('id', '=', workspaceId)
        .execute();
      expect(await store.findById(record.id)).toBeNull();
      expect((await store.list({ workspaceId }, params())).data).toEqual([]);
      expect(await store.findByHash(hashApiKey(key, PEPPER))).toMatchObject({
        workspaceLive: false,
      });
      await t.db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
      const { rows } = await sql<{ n: string }>`select count(*) as n from api_keys`.execute(t.db);
      expect(rows[0]?.n).toBe('0');
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('refuses rows that break the table rules', async () => {
    const t = await migratedDatabase(5);
    try {
      const { userId, workspaceId } = await arrange(t.db);
      const base = {
        id: newId('key'),
        workspace_id: workspaceId,
        created_by: userId,
        name: 'CI',
        mode: 'live',
        key_hash: 'a'.repeat(64),
        prefix: 'cen_live_Ab3',
        scope: 'workspaces:read',
      };
      const bad: Record<string, unknown>[] = [
        { id: 'key_short' },
        { name: '' },
        { name: 'x'.repeat(61) },
        { mode: 'prod' },
        { key_hash: 'not-hex' },
        { prefix: 'cen_live_Ab3k' },
        { prefix: 'cen_test_Ab3' },
        { scope: 'workspaces:read admin' },
        { scope: 'admin' },
      ];
      for (const change of bad) {
        await expect(
          // Values the types forbid, on purpose: the database must refuse them too.
          keysDb(t.db)
            .insertInto('api_keys')
            .values({ ...base, ...change } as never)
            .execute(),
          JSON.stringify(change),
        ).rejects.toThrow();
      }
      await keysDb(t.db)
        .insertInto('api_keys')
        .values({ ...base, mode: 'live' })
        .execute();
      await expect(
        keysDb(t.db)
          .insertInto('api_keys')
          .values({ ...base, id: newId('key'), mode: 'live' })
          .execute(),
      ).rejects.toThrow(/api_keys_key_hash_key/);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
