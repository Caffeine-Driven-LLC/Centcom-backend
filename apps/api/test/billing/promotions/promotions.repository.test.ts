/**
 * The promotions repository's statements on a scripted driver (B079; the same statements run on
 * Postgres in promotions.postgres.test.ts, CI's integration job):
 *
 * - `record` is one short transaction: the ledger insert (`on conflict (workspace_id,
 *   stripe_promotion_id) do nothing returning id`), then the audit write in the same transaction;
 *   on a conflict it reads the stored fingerprint instead and writes nothing more; a failing audit
 *   write rolls the row back. No Stripe call happens inside it (the service calls Stripe first);
 * - `findRedemption` reads the stored fingerprint by workspace and promotion;
 * - `recordTrial` keeps the trial and its owners in one transaction, ignoring any unique conflict;
 *   `trialUsed` matches the workspace, then the owners; `ownersOf` reads owners in join order.
 */
import type { PromotionsDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createPromotionRepository } from '../../../src/modules/billing/promotions/repository.js';
import { scriptedDb, type Reply } from '../../modules/users/helpers.js';
import { newId, stripeId } from './helpers.js';

function scripted(reply: (sql: string) => Reply = () => ({})) {
  const { db, statements } = scriptedDb((query) => reply(query.sql));
  return {
    repository: createPromotionRepository(db as unknown as Kysely<PromotionsDb>),
    statements,
  };
}

const row = () => ({
  id: newId('req').slice('req_'.length),
  workspaceId: newId('wsp'),
  userId: newId('usr'),
  codeHash: 'a'.repeat(64),
  stripePromotionId: stripeId('promo'),
  requestFingerprint: 'b'.repeat(64),
});

describe('the promotions repository statements', () => {
  it('records the row and its audit event in one short transaction', async () => {
    const { repository, statements } = scripted((sql) =>
      sql.startsWith('insert into "coupon_redemptions"') ? { rows: [{ id: 'x' }] } : {},
    );
    const audited: boolean[] = [];
    const outcome = await repository.record(row(), (trx) => {
      audited.push(trx.isTransaction);
      return Promise.resolve();
    });
    expect(outcome).toEqual({ recorded: true });
    expect(audited).toEqual([true]);
    expect(statements[0]).toBe('begin');
    expect(statements[1]).toContain(
      'on conflict ("workspace_id", "stripe_promotion_id") do nothing returning "id"',
    );
    expect(statements.at(-1)).toBe('commit');
  });

  it('answers the stored fingerprint on a conflict, and rolls back a failed audit write', async () => {
    const conflict = scripted((sql) =>
      sql.startsWith('select "request_fingerprint"')
        ? { rows: [{ request_fingerprint: 'c'.repeat(64) }] }
        : {},
    );
    let audited = false;
    const outcome = await conflict.repository.record(row(), () => {
      audited = true;
      return Promise.resolve();
    });
    expect(outcome).toEqual({ recorded: false, existing: { requestFingerprint: 'c'.repeat(64) } });
    expect(audited).toBe(false);
    expect(conflict.statements.at(-1)).toBe('commit');

    const failing = scripted((sql) =>
      sql.startsWith('insert into "coupon_redemptions"') ? { rows: [{ id: 'x' }] } : {},
    );
    await expect(
      failing.repository.record(row(), () => Promise.reject(new Error('audit down'))),
    ).rejects.toThrow('audit down');
    expect(failing.statements.at(-1)).toBe('rollback');
  });

  it('finds a redemption by workspace and promotion', async () => {
    const { repository, statements } = scripted((sql) =>
      sql.startsWith('select') ? { rows: [{ request_fingerprint: null }] } : {},
    );
    expect(await repository.findRedemption(newId('wsp'), stripeId('promo'))).toEqual({
      requestFingerprint: null,
    });
    expect(statements[0]).toContain('where "workspace_id" = $1 and "stripe_promotion_id" = $2');
    const none = scripted();
    expect(await none.repository.findRedemption(newId('wsp'), stripeId('promo'))).toBeNull();
  });

  it('keeps a trial with its owners, and finds it by workspace or owner', async () => {
    const { repository, statements } = scripted((sql) =>
      sql.startsWith('insert into "billing_trials"')
        ? { rows: [{ stripe_subscription_id: 'sub_x' }] }
        : sql.includes('from "memberships"')
          ? { rows: [{ user_id: 'usr_a' }, { user_id: 'usr_b' }] }
          : sql.includes('from "billing_trial_owners"')
            ? { rows: [{ stripe_subscription_id: 'sub_x' }] }
            : { rows: [] },
    );
    expect(
      await repository.recordTrial({
        stripeSubscriptionId: stripeId('sub'),
        workspaceId: newId('wsp'),
        ownerUserIds: ['usr_a', 'usr_b', 'usr_a'],
        trialEnd: null,
      }),
    ).toBe(true);
    expect(statements[0]).toBe('begin');
    expect(statements[1]).toContain('insert into "billing_trials"');
    expect(statements[1]).toContain('on conflict do nothing');
    expect(statements[2]).toContain('insert into "billing_trial_owners"');
    expect(statements[2]).toContain('values ($1, $2), ($3, $4) on conflict do nothing');
    expect(statements[3]).toBe('commit');

    const used = statements.length;
    expect(await repository.trialUsed(newId('wsp'), [])).toBe(false);
    expect(statements[used]).toContain('from "billing_trials" where "workspace_id" = $1');
    expect(await repository.trialUsed(newId('wsp'), ['usr_a'])).toBe(true);
    expect(statements.at(-1)).toContain('from "billing_trial_owners" where "user_id" in ($1)');
    expect(await repository.ownersOf(newId('wsp'))).toEqual(['usr_a', 'usr_b']);
    expect(statements.at(-1)).toContain('"role" = $2 order by "created_at", "id"');
  });

  it('writes no owners for a trial already kept', async () => {
    const { repository, statements } = scripted();
    expect(
      await repository.recordTrial({
        stripeSubscriptionId: stripeId('sub'),
        workspaceId: newId('wsp'),
        ownerUserIds: ['usr_a'],
        trialEnd: null,
      }),
    ).toBe(false);
    expect(statements.some((s) => s.includes('billing_trial_owners'))).toBe(false);
  });
});
