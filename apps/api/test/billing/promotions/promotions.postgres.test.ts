/**
 * Trials and promotions on Postgres 16 (B079; DATABASE_URL, CI's integration job): the
 * repository's own statements.
 *
 * - `record` writes the ledger row and the audit event in one short transaction: a failed audit
 *   write leaves no row; a second record of one promotion by one workspace writes nothing and
 *   answers the stored fingerprint, also when 10 run at once; the row holds the code's hash,
 *   never the code; `findRedemption` reads it back;
 * - `recordTrial` keeps one trial per subscription and per workspace, with every owner;
 *   `trialUsed` finds it by workspace and by any of its owners; `ownersOf` lists a workspace's
 *   owners, earliest first;
 * - purging the workspace keeps its trial (`workspace_id` set null) and its owners; deleting an
 *   owner's account removes only their owner row.
 */
import { createAuditEmitter, type AuditDb } from '@centcom/core';
import type { PromotionsDb } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { codeHash } from '../../../src/modules/billing/promotions/codes.js';
import { createPromotionRepository } from '../../../src/modules/billing/promotions/repository.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgUser,
  pgWorkspace,
} from '../../notifications/dispatcher/postgres.js';
import { newId, stripeId } from './helpers.js';

const ulid = () => newId('req').slice('req_'.length);

async function setup() {
  const t = await migratedDatabase(20);
  const db = t.db as unknown as Kysely<PromotionsDb>;
  const owner = await pgUser(t.db);
  const ws = await pgWorkspace(t.db, owner);
  await pgJoin(t.db, ws, owner, 'owner');
  const repository = createPromotionRepository(db);
  const emitter = createAuditEmitter({ db: db as unknown as AuditDb });
  const row = (promotion: string, fingerprint = codeHash(ulid())) => ({
    id: ulid(),
    workspaceId: ws,
    userId: owner,
    codeHash: codeHash('SPRING25'),
    stripePromotionId: promotion,
    requestFingerprint: fingerprint,
  });
  const audit = (trx: AuditDb) =>
    emitter.emit(trx, {
      workspaceId: ws,
      actor: { type: 'user', id: owner },
      action: 'billing.coupon',
      target: { type: 'workspace', id: ws },
      outcome: 'success',
      meta: { plan: 'team' },
    });
  const count = async (table: 'coupon_redemptions' | 'audit_events') =>
    Number(
      (await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(db))
        .rows[0]?.n,
    );
  return { t, db, owner, ws, repository, row, audit, count };
}

describe.runIf(ADMIN_URL !== undefined)('trials and promotions on Postgres 16', () => {
  it('records the row and its audit event together, once per workspace and promotion', async () => {
    const s = await setup();
    try {
      const promo = stripeId('promo');
      const failed = await s.repository
        .record(s.row(promo), () => Promise.reject(new Error('audit down')))
        .catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(Error);
      expect(await s.count('coupon_redemptions')).toBe(0);
      expect(await s.repository.findRedemption(s.ws, promo)).toBeNull();

      const first = s.row(promo);
      expect(await s.repository.record(first, s.audit)).toEqual({ recorded: true });
      expect(await s.count('coupon_redemptions')).toBe(1);
      expect(await s.count('audit_events')).toBe(1);
      const stored = await s.db
        .selectFrom('coupon_redemptions')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(stored).toMatchObject({
        workspace_id: s.ws,
        user_id: s.owner,
        code_hash: codeHash('SPRING25'),
        stripe_promotion_id: promo,
        request_fingerprint: first.requestFingerprint,
      });
      expect(JSON.stringify(stored)).not.toContain('SPRING25');
      expect(await s.repository.findRedemption(s.ws, promo)).toEqual({
        requestFingerprint: first.requestFingerprint,
      });

      expect(await s.repository.record(s.row(promo), s.audit)).toEqual({
        recorded: false,
        existing: { requestFingerprint: first.requestFingerprint },
      });
      expect(await s.count('audit_events')).toBe(1);
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('records one of 10 concurrent records of one promotion', async () => {
    const s = await setup();
    try {
      const promo = stripeId('promo');
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => s.repository.record(s.row(promo), s.audit)),
      );
      expect(outcomes.filter((o) => o.recorded)).toHaveLength(1);
      expect(await s.count('coupon_redemptions')).toBe(1);
      expect(await s.count('audit_events')).toBe(1);
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('keeps one trial per subscription and workspace, with every owner, across purges', async () => {
    const s = await setup();
    try {
      const coOwner = await pgUser(s.t.db);
      await pgJoin(s.t.db, s.ws, coOwner, 'owner');
      const member = await pgUser(s.t.db);
      await pgJoin(s.t.db, s.ws, member, 'member');
      expect(await s.repository.ownersOf(s.ws)).toEqual([s.owner, coOwner]);

      const sub = stripeId('sub');
      const trial = {
        stripeSubscriptionId: sub,
        workspaceId: s.ws,
        ownerUserIds: [s.owner, coOwner],
        trialEnd: new Date('2026-10-12T00:00:00.000Z'),
      };
      expect(await s.repository.recordTrial(trial)).toBe(true);
      expect(await s.repository.recordTrial(trial)).toBe(false);
      expect(
        await s.repository.recordTrial({ ...trial, stripeSubscriptionId: stripeId('sub') }),
      ).toBe(false);
      const owners = await s.db.selectFrom('billing_trial_owners').select('user_id').execute();
      expect(owners.map((o) => o.user_id).sort()).toEqual([s.owner, coOwner].sort());

      const second = await pgWorkspace(s.t.db, s.owner);
      expect(await s.repository.trialUsed(s.ws, [])).toBe(true);
      expect(await s.repository.trialUsed(second, [])).toBe(false);
      expect(await s.repository.trialUsed(second, [coOwner])).toBe(true);
      expect(await s.repository.trialUsed(second, [member])).toBe(false);

      // The workspace is purged: its trial and owners stay.
      await s.db.deleteFrom('memberships').where('workspace_id', '=', s.ws).execute();
      await s.db.deleteFrom('workspaces').where('id', '=', s.ws).execute();
      const kept = await s.db.selectFrom('billing_trials').selectAll().executeTakeFirstOrThrow();
      expect(kept).toMatchObject({ stripe_subscription_id: sub, workspace_id: null });
      expect(await s.repository.trialUsed(second, [s.owner])).toBe(true);

      // An owner's account is deleted: only their owner row goes.
      await s.db.deleteFrom('users').where('id', '=', coOwner).execute();
      const left = await s.db.selectFrom('billing_trial_owners').select('user_id').execute();
      expect(left.map((o) => o.user_id)).toEqual([s.owner]);
    } finally {
      await s.t.drop();
    }
  }, 60_000);
});
