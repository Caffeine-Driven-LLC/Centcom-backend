/**
 * The SQL of trials and promotions (B079, migration 20260102003800).
 *
 * - `findRedemption` reads a workspace's redemption of a promotion (its request fingerprint), so a
 *   retry of the request that wrote it can answer as it did, and any other is refused.
 * - `record` writes a redemption and its audit event in one short transaction, after Stripe
 *   applied the promotion (no transaction ever waits on Stripe): the ledger row first, unique on
 *   `(workspace_id, stripe_promotion_id)`; none when the workspace has it already (then the stored
 *   fingerprint is answered and nothing else is written); else the audit event.
 * - `recordTrial` keeps a trial Stripe confirmed, once per subscription and per workspace, with
 *   every owner of the workspace at the time.
 * - `trialUsed` says whether a workspace, or any of some users, had a trial; `ownersOf` names a
 *   workspace's owners.
 *
 * Owns: the statements. Must not: store a code (only its hash), card data or Stripe payloads.
 */
import type { AuditDb } from '@centcom/core';
import type { PromotionsDb } from '@centcom/db';
import type { Kysely } from 'kysely';

/** A redemption to record. */
export interface RedemptionRow {
  /** A bare ULID. */
  id: string;
  workspaceId: string;
  /** Null for a staff grant or an API key. */
  userId: string | null;
  /** sha256 (hex) of the normalised code. */
  codeHash: string;
  stripePromotionId: string;
  /** sha256 (hex) of the Idempotency-Key, else of the request id; null for internal callers. */
  requestFingerprint: string | null;
}

/** A stored redemption, as a retry compares it. */
export interface StoredRedemption {
  requestFingerprint: string | null;
}

/** A trial Stripe confirmed. */
export interface TrialRow {
  stripeSubscriptionId: string;
  workspaceId: string;
  /** The workspace's owners when the trial began. */
  ownerUserIds: readonly string[];
  trialEnd: Date | null;
}

/** What `record` came to. */
export type RecordOutcome = { recorded: true } | { recorded: false; existing: StoredRedemption };

/** Trials and promotions persistence. */
export interface PromotionRepository {
  /** The workspace's redemption of `stripePromotionId`, or null. */
  findRedemption(workspaceId: string, stripePromotionId: string): Promise<StoredRedemption | null>;
  /** See the module comment. */
  record(row: RedemptionRow, audit?: (trx: AuditDb) => Promise<unknown>): Promise<RecordOutcome>;
  /** Keeps a confirmed trial and its owners; false when its subscription or workspace has one. */
  recordTrial(trial: TrialRow): Promise<boolean>;
  /** Whether the workspace, or any of `userIds` as an owner, had a trial. */
  trialUsed(workspaceId: string, userIds: readonly string[]): Promise<boolean>;
  /** The workspace's owners, earliest first. */
  ownersOf(workspaceId: string): Promise<string[]>;
}

/** The repository on Postgres. */
export function createPromotionRepository<DB extends PromotionsDb>(
  database: Kysely<DB>,
): PromotionRepository {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<PromotionsDb>;

  return {
    async findRedemption(workspaceId, stripePromotionId) {
      const row = await db
        .selectFrom('coupon_redemptions')
        .select('request_fingerprint')
        .where('workspace_id', '=', workspaceId)
        .where('stripe_promotion_id', '=', stripePromotionId)
        .executeTakeFirst();
      return row === undefined ? null : { requestFingerprint: row.request_fingerprint };
    },

    record(row, audit) {
      return db.transaction().execute(async (trx): Promise<RecordOutcome> => {
        const inserted = await trx
          .insertInto('coupon_redemptions')
          .values({
            id: row.id,
            workspace_id: row.workspaceId,
            user_id: row.userId,
            code_hash: row.codeHash,
            stripe_promotion_id: row.stripePromotionId,
            request_fingerprint: row.requestFingerprint,
          })
          .onConflict((oc) => oc.columns(['workspace_id', 'stripe_promotion_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted === undefined) {
          const existing = await trx
            .selectFrom('coupon_redemptions')
            .select('request_fingerprint')
            .where('workspace_id', '=', row.workspaceId)
            .where('stripe_promotion_id', '=', row.stripePromotionId)
            .executeTakeFirst();
          return {
            recorded: false,
            existing: { requestFingerprint: existing?.request_fingerprint ?? null },
          };
        }
        if (audit !== undefined) await audit(trx);
        return { recorded: true };
      });
    },

    recordTrial(trial) {
      return db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('billing_trials')
          .values({
            stripe_subscription_id: trial.stripeSubscriptionId,
            workspace_id: trial.workspaceId,
            trial_end: trial.trialEnd,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('stripe_subscription_id')
          .executeTakeFirst();
        if (inserted === undefined) return false;
        if (trial.ownerUserIds.length > 0) {
          await trx
            .insertInto('billing_trial_owners')
            .values(
              [...new Set(trial.ownerUserIds)].map((userId) => ({
                stripe_subscription_id: trial.stripeSubscriptionId,
                user_id: userId,
              })),
            )
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        return true;
      });
    },

    async trialUsed(workspaceId, userIds) {
      const byWorkspace = await db
        .selectFrom('billing_trials')
        .select('stripe_subscription_id')
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();
      if (byWorkspace !== undefined || userIds.length === 0) return byWorkspace !== undefined;
      const byOwner = await db
        .selectFrom('billing_trial_owners')
        .select('stripe_subscription_id')
        .where('user_id', 'in', [...userIds])
        .limit(1)
        .executeTakeFirst();
      return byOwner !== undefined;
    },

    async ownersOf(workspaceId) {
      const rows = await db
        .selectFrom('memberships')
        .select('user_id')
        .where('workspace_id', '=', workspaceId)
        .where('role', '=', 'owner')
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map((r) => r.user_id);
    },
  };
}
