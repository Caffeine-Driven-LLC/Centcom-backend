/**
 * The account lifecycle on Postgres 16 (B026; DATABASE_URL, CI's integration job), through the
 * real store, migration and B036's emitter:
 *
 * - `scheduleDeletion` revokes every refresh token and device in the transaction that sets the
 *   deadline (a failing audit write leaves neither), keeps the first deadline, and refuses the only
 *   owner of a workspace with other members (acceptance 1-3; guardrail "same transaction");
 * - of two concurrent export requests one is created (acceptance 4); `exportData` reads only the
 *   user's own rows: no teammate's e-mail (acceptance 5);
 * - restore within the grace period, then 409; after it 410 (acceptance 9);
 * - the audit log stays append-only: a direct UPDATE is still refused.
 */
import { newId } from '@centcom/contracts';
import { createAuditEmitter, type AuditDb } from '@centcom/core';
import type { CoreDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_LIFECYCLE_ACTIONS,
  createAccountLifecycleStore,
  type LifecycleDb,
} from '../../src/modules/account-lifecycle/index.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgUser,
  pgWorkspace,
} from '../notifications/dispatcher/postgres.js';
import type { TestDatabase } from '../modules/users/helpers.js';
import { seedPersonalData } from './postgres.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe.runIf(ADMIN_URL !== undefined)('the account lifecycle store on Postgres 16', () => {
  let test: TestDatabase;
  let db: Kysely<LifecycleDb>;
  let core: Kysely<CoreDatabase>;
  const noAudit = () => Promise.resolve();

  beforeAll(async () => {
    test = await migratedDatabase(10);
    core = test.db;
    db = test.db as unknown as Kysely<LifecycleDb>;
  });
  afterAll(async () => {
    await test?.drop();
  });

  it('schedules once, revoking tokens and devices in the same transaction', async () => {
    const store = createAccountLifecycleStore(db);
    const userId = await pgUser(core);
    const seeded = await seedPersonalData(db, userId);
    const at = new Date();
    const deadline = new Date(at.getTime() + 30 * DAY_MS);

    // An audit failure rolls everything back: nothing scheduled, nothing revoked.
    await expect(
      store.scheduleDeletion(userId, at, deadline, () => Promise.reject(new Error('audit down'))),
    ).rejects.toThrow('audit down');
    const untouched = await db
      .selectFrom('users')
      .select(['status', 'deletion_scheduled_at'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(untouched).toEqual({ status: 'active', deletion_scheduled_at: null });
    const live = await db
      .selectFrom('refresh_tokens')
      .select('revoked_at')
      .where('user_id', '=', userId)
      .execute();
    expect(live.every((r) => r.revoked_at === null)).toBe(true);

    const emitter = createAuditEmitter({
      db: db as unknown as AuditDb,
      actions: ACCOUNT_LIFECYCLE_ACTIONS,
    });
    const first = await store.scheduleDeletion(userId, at, deadline, (trx) =>
      emitter.emit(trx, {
        workspaceId: null,
        actor: { type: 'user', id: userId },
        action: 'account.delete_request',
        target: { type: 'user', id: userId },
        outcome: 'success',
      }),
    );
    expect(first).toEqual({
      kind: 'scheduled',
      scheduledFor: deadline,
      revokedDevices: [seeded.deviceId],
    });
    const tokens = await db
      .selectFrom('refresh_tokens')
      .select('revoked_at')
      .where('user_id', '=', userId)
      .execute();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((r) => r.revoked_at !== null)).toBe(true);
    const audited = await db
      .selectFrom('audit_events')
      .select('action')
      .where('actor_id', '=', userId)
      .where('action', '=', 'account.delete_request')
      .execute();
    expect(audited).toHaveLength(1);

    const second = await store.scheduleDeletion(
      userId,
      new Date(at.getTime() + DAY_MS),
      new Date(at.getTime() + 31 * DAY_MS),
      noAudit,
    );
    expect(second).toEqual({ kind: 'already', scheduledFor: deadline, revokedDevices: [] });
  });

  it('refuses the only owner of a workspace with other members, and nothing changes', async () => {
    const store = createAccountLifecycleStore(db);
    const owner = await pgUser(core);
    const member = await pgUser(core);
    const workspaceId = await pgWorkspace(core, owner);
    await pgJoin(core, workspaceId, owner, 'owner');
    await pgJoin(core, workspaceId, member, 'member');
    const seeded = await seedPersonalData(db, owner);
    const outcome = await store.scheduleDeletion(owner, new Date(), new Date(), noAudit);
    expect(outcome).toEqual({ kind: 'blocked', workspaceIds: [workspaceId] });
    const device = await db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', seeded.deviceId)
      .executeTakeFirstOrThrow();
    expect(device.revoked_at).toBeNull();

    // Once the other member has left it no longer blocks; a workspace the user is alone in never
    // does (a workspace has exactly one owner: memberships_workspace_id_owner_key).
    await db.deleteFrom('memberships').where('user_id', '=', member).execute();
    const alone = await pgWorkspace(core, owner);
    await pgJoin(core, alone, owner, 'owner');
    const ok = await store.scheduleDeletion(owner, new Date(), new Date(), noAudit);
    expect(ok.kind).toBe('scheduled');
  });

  it('restores before the deadline, then 409; after the deadline it is expired', async () => {
    const store = createAccountLifecycleStore(db);
    const userId = await pgUser(core);
    const now = new Date();
    await store.scheduleDeletion(userId, now, new Date(now.getTime() + 30 * DAY_MS), noAudit);
    const restored = await store.restore(userId, new Date(now.getTime() + DAY_MS), noAudit);
    expect(restored.kind).toBe('restored');
    if (restored.kind === 'restored') {
      expect(restored.user).toMatchObject({
        id: userId,
        status: 'active',
        deletion_requested_at: null,
      });
    }
    expect((await store.restore(userId, now, noAudit)).kind).toBe('not_pending');
    await store.scheduleDeletion(userId, now, new Date(now.getTime() + 30 * DAY_MS), noAudit);
    expect((await store.restore(userId, new Date(now.getTime() + 31 * DAY_MS), noAudit)).kind).toBe(
      'expired',
    );
    expect(await store.cancelDeletion(userId)).toBe(true);
    expect(await store.cancelDeletion(userId)).toBe(false);
  });

  it('creates one of two concurrent exports, and exports only the user’s own rows', async () => {
    const store = createAccountLifecycleStore(db);
    const userId = await pgUser(core);
    const teammate = await pgUser(core);
    const workspaceId = await pgWorkspace(core, userId);
    await pgJoin(core, workspaceId, userId, 'owner');
    await pgJoin(core, workspaceId, teammate, 'member');
    await seedPersonalData(db, userId, workspaceId);
    await seedPersonalData(db, teammate, workspaceId);
    const now = new Date();
    const since = new Date(now.getTime() - DAY_MS);
    const results = await Promise.all(
      [newId('exp'), newId('exp')].map((id) =>
        store.createExport({ id, userId, createdAt: now }, since, noAudit),
      ),
    );
    expect(results.map((r) => r.kind).sort()).toEqual(['created', 'limited']);

    const data = await store.exportData(userId, 100);
    expect(data).not.toBeNull();
    expect(data?.memberships.map((m) => m.workspace_id)).toEqual([workspaceId]);
    expect(data?.memberships).toHaveLength(1);
    expect(data?.apiKeys).toHaveLength(1);
    expect(data?.devices).toHaveLength(1);
    expect(data?.auditEvents.length).toBeGreaterThan(0);
    const text = JSON.stringify(data);
    expect(text).not.toContain(`${teammate.toLowerCase()}@example.test`);
    expect(text).not.toContain('key_hash');
    expect(text).not.toMatch(/[0-9a-f]{64}/);

    // The row moves pending → running → ready → expired, and only forward.
    const id = (
      await db
        .selectFrom('account_exports')
        .select('id')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow()
    ).id;
    expect((await store.claimExport(id))?.status).toBe('running');
    await store.markReady(
      id,
      `exports/${userId}/${id}.json`,
      10,
      new Date(now.getTime() + 7 * DAY_MS),
    );
    expect(await store.claimExport(id)).toBeNull();
    await store.markFailed(id, 'internal');
    expect((await store.getExport(userId, id))?.status).toBe('ready');
    expect(await store.getExport(teammate, id)).toBeNull();
    const due = await store.dueForExpiry(new Date(now.getTime() + 8 * DAY_MS), 10);
    expect(due.map((r) => r.id)).toContain(id);
    await store.markExpired(id);
    expect((await store.getExport(userId, id))?.status).toBe('expired');
  });

  it('keeps audit_events append-only outside the pseudonymising function', async () => {
    await expect(
      sql`update audit_events set actor_id = 'usr_deleted'`.execute(db),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql`select pseudonymise_audit_user(${'not-a-user'})`.execute(db),
    ).rejects.toMatchObject({ code: '22023' });
  });
});
