/**
 * The share-link store on Postgres 16 (B068; DATABASE_URL, CI's integration job), with migration
 * 20260102005000_share_links.sql:
 * - only the token's SHA-256 is stored (a dump of the table holds no plain token);
 * - `consume` is atomic: 50 concurrent uses of a 10-use link spend exactly 10;
 * - a failing step rolls the use and the guest back;
 * - revoke deletes the link's guests;
 * - sweep deletes the guests of expired links and ended sessions;
 * - the table refuses a link living past 24 h;
 * - guests count as members.
 */
import { createHash } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresShareLinkStore,
  hashShareToken,
  newShareToken,
  type ShareLinkDb,
} from '../../src/modules/share-links/index.js';
import type { TestDatabase } from '../modules/users/helpers.js';
import { ADMIN_URL, lifecycleOn, migratedDatabase, T0 } from '../sessions/lifecycle/helpers.js';

describe.runIf(ADMIN_URL !== undefined)('share links on Postgres 16', () => {
  let test: TestDatabase;
  let db: ShareLinkDb;
  beforeAll(async () => {
    test = await migratedDatabase(20);
    db = test.db as unknown as ShareLinkDb;
  });
  afterAll(async () => {
    await test?.drop();
  });

  async function session() {
    const env = lifecycleOn(test.db);
    env.entitlements.state.limits['max_concurrent_sessions'] = null;
    const w = await env.seed();
    const s = await env.service.create({
      workspaceId: w.workspace,
      creatorUserId: w.owner.user,
      creatorDeviceId: w.owner.device,
      name: 'Demo',
      region: 'eu',
    });
    return { env, s };
  }

  async function link(sessionId: string, host: string, maxUses = 10, ttlMs = 3_600_000) {
    const store = createPostgresShareLinkStore(db);
    const token = newShareToken();
    const record = await store.create({
      sessionId,
      tokenHash: hashShareToken(token),
      expiresAt: new Date(T0 + ttlMs),
      maxUses,
      createdByMember: host,
      createdAt: new Date(T0),
    });
    return { store, token, record };
  }

  const guest = (sessionId: string, slot: number) => ({
    memberId: newId('mem'),
    sessionId,
    name: 'Guest',
    slot,
  });

  it('stores only the hash, finds by it, and counts guests as members', async () => {
    const { s } = await session();
    const { store, token, record } = await link(s.id, s.host ?? '');
    const dump = await sql<{
      t: string;
    }>`select row_to_json(share_link)::text as t from share_link`.execute(db);
    const text = dump.rows.map((r) => r.t).join('\n');
    expect(text).not.toContain(token);
    expect(text).toContain(createHash('sha256').update(token).digest('hex'));
    expect((await store.findByHash(hashShareToken(token)))?.id).toBe(record.id);
    expect(await store.findByHash(hashShareToken('nope'))).toBeNull();
    expect(await store.countMembers(s.id)).toBe(1);
    await store.consume(record.id, new Date(T0), guest(s.id, 1), () => Promise.resolve('t'));
    expect(await store.countMembers(s.id)).toBe(2);
    expect(await store.session(s.id)).toMatchObject({
      id: s.id,
      state: 'live',
      region: 'eu',
      locked: false,
    });
  });

  it('50 concurrent uses of a 10-use link spend exactly 10', async () => {
    const { s } = await session();
    const { store, record } = await link(s.id, s.host ?? '', 10);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.consume(record.id, new Date(T0), guest(s.id, (i % 49) + 1), () => Promise.resolve(i)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    const row = await db
      .selectFrom('share_link')
      .select('uses')
      .where('id', '=', record.id)
      .executeTakeFirstOrThrow();
    expect(row.uses).toBe(10);
    const guests = await db
      .selectFrom('guest_member')
      .select('member_id')
      .where('share_link_id', '=', record.id)
      .execute();
    expect(guests).toHaveLength(10);
  });

  it('a failing step rolls back the use and the guest; an expired link is not used', async () => {
    const { s } = await session();
    const { store, record } = await link(s.id, s.host ?? '', 1);
    await expect(
      store.consume(record.id, new Date(T0), guest(s.id, 1), () =>
        Promise.reject(new Error('no key')),
      ),
    ).rejects.toThrow('no key');
    const row = await db
      .selectFrom('share_link')
      .select('uses')
      .where('id', '=', record.id)
      .executeTakeFirstOrThrow();
    expect(row.uses).toBe(0);
    expect(
      await store.consume(record.id, new Date(T0 + 3_600_000), guest(s.id, 1), () =>
        Promise.resolve(1),
      ),
    ).toEqual({ ok: false });
  });

  it('revoke deletes the guests; sweep deletes those of expired links and ended sessions', async () => {
    const { s, env } = await session();
    const a = await link(s.id, s.host ?? '');
    const g = guest(s.id, 1);
    await a.store.consume(a.record.id, new Date(T0), g, () => Promise.resolve(1));
    const revoked = await a.store.revoke(s.id, hashShareToken(a.token), new Date(T0 + 1000));
    expect(revoked?.guests).toEqual([g.memberId]);
    expect(revoked?.link.revokedAt).not.toBeNull();
    expect(await a.store.revoke(s.id, hashShareToken('other'), new Date(T0))).toBeNull();

    const b = await link(s.id, s.host ?? '', 10, 60_000);
    const g2 = guest(s.id, 2);
    await b.store.consume(b.record.id, new Date(T0), g2, () => Promise.resolve(1));
    const c = await link(s.id, s.host ?? '', 10, 3_600_000);
    const g3 = guest(s.id, 3);
    await c.store.consume(c.record.id, new Date(T0), g3, () => Promise.resolve(1));
    expect(await b.store.sweep(new Date(T0 + 60_000))).toEqual([
      { sessionId: s.id, memberIds: [g2.memberId] },
    ]);
    await env.service.end(s.id, {
      userId: (
        await test.db
          .selectFrom('sessions')
          .select('created_by')
          .where('id', '=', s.id)
          .executeTakeFirstOrThrow()
      ).created_by,
      reason: 'done',
    });
    expect(await c.store.sweep(new Date(T0 + 61_000))).toEqual([
      { sessionId: s.id, memberIds: [g3.memberId] },
    ]);
  });

  it('refuses a link that lives past 24 h', async () => {
    const { s } = await session();
    await expect(link(s.id, s.host ?? '', 10, 24 * 3_600_000 + 1_000)).rejects.toThrow();
  });
});
