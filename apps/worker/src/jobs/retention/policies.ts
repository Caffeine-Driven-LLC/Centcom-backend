/**
 * The retention policy registry (B090): every dataset the job purges, in run order, with its
 * owner and rule. The rules (cutoffs, statuses) are in the stores' SQL (@centcom/db's retention
 * repository); docs/platform/data-retention.md lists them all, with the datasets other lanes or
 * Redis already expire.
 *
 * | Policy                | Owner | Due                                                             | Brake |
 * | --------------------- | ----- | --------------------------------------------------------------- | ----- |
 * | `history`             | B055  | ended sessions' history past the effective `history_days`      | yes   |
 * | `audit`               | B036  | workspace audit events past `audit_log_days`                   | yes   |
 * | `audit_staff_details` | B087  | staff call details whose audit event is gone                   | no    |
 * | `webhook_log`         | B081  | webhook events and deliveries created over 30 days ago         | yes   |
 * | `notifications`       | B063  | notifications created over 90 days ago (the inbox hides them)  | yes   |
 * | `refresh_tokens`      | B017  | token families past their 180-day absolute expiry              | yes   |
 * | `login_tokens`        | B014  | magic-link tokens past their expiry (15 minutes)               | no    |
 * | `device_codes`        | B016  | device-flow grants 10 minutes past their expiry                | no    |
 * | `invites`             | B029  | invites accepted, revoked or expired over 30 days ago          | yes   |
 * | `account_exports`     | B026  | export rows expired over 30 days ago (B026 deletes the files)  | yes   |
 * | `audit_exports`       | B082  | audit export rows expired over 30 days ago (B082: the files)   | yes   |
 * | `stripe_events`       | B072  | processed or ignored Stripe events received over 90 days ago   | yes   |
 * | `billing_outbox`      | B072  | outbox rows published over 30 days ago                         | yes   |
 * | `billing_trials`      | B079  | trials (and owners) 24 months after they ended                 | yes   |
 * | `retention_runs`      | B090  | this job's run reports finished over 90 days ago               | yes   |
 * | `telemetry`           | B085  | nothing: reports raw telemetry past 90 days (B085 drops it)    | n/a   |
 *
 * The brake is off for the two tables whose rows live minutes by design (almost every row is due
 * every night) and for `audit_staff_details`, which only follows the `audit` policy's deletions
 * (that policy's brake guards them). Later lanes add theirs as `extra` policies (B026's account
 * purge finaliser, B068's share links, B056's snapshots when they need their own), run last.
 *
 * Owns: the list. Must not: hold SQL.
 */
import type { Logger, Metrics, PubSub } from '@centcom/core';
import { createAuditPolicy, type AuditRetentionStore } from './audit.js';
import type { DecideCursor } from './cursor.js';
import type { RetentionStateStore } from './effective.js';
import {
  createHistoryPolicy,
  type HistoryRetentionStore,
  type RetentionEntitlementsReader,
  type RetentionMailer,
  type SessionBlobPurger,
} from './history.js';
import type { RetentionPolicy } from './policy.js';
import { createRowPolicy, type RowRetentionStore } from './rows.js';
import { createTelemetryReportPolicy, type TelemetryReportStore } from './telemetry.js';

/** The row policies, in run order: id, owner and whether the fraction brake applies. */
export const ROW_POLICIES = Object.freeze([
  { id: 'audit_staff_details', owner: 'B087', guard: false },
  { id: 'webhook_log', owner: 'B081', guard: true },
  { id: 'notifications', owner: 'B063', guard: true },
  { id: 'refresh_tokens', owner: 'B017', guard: true },
  { id: 'login_tokens', owner: 'B014', guard: false },
  { id: 'device_codes', owner: 'B016', guard: false },
  { id: 'invites', owner: 'B029', guard: true },
  { id: 'account_exports', owner: 'B026', guard: true },
  { id: 'audit_exports', owner: 'B082', guard: true },
  { id: 'stripe_events', owner: 'B072', guard: true },
  { id: 'billing_outbox', owner: 'B072', guard: true },
  { id: 'billing_trials', owner: 'B079', guard: true },
  { id: 'retention_runs', owner: 'B090', guard: true },
] as const);

/** A row policy's id. */
export type RowPolicyId = (typeof ROW_POLICIES)[number]['id'];

/** The Postgres side of every policy (@centcom/db's `createRetentionRepository`). */
export interface RetentionStores {
  state: RetentionStateStore;
  history: HistoryRetentionStore;
  audit: AuditRetentionStore;
  telemetry: TelemetryReportStore;
  rows: Record<RowPolicyId, RowRetentionStore>;
}

/** What the registry needs. */
export interface RetentionPoliciesDeps {
  stores: RetentionStores;
  /** Where the history and audit policies' next runs continue (`createDecideCursor`). */
  cursor: DecideCursor;
  /** B055's `HistoryStore`. */
  history: SessionBlobPurger;
  /** B056's snapshot store, once it exists. */
  snapshots?: SessionBlobPurger;
  entitlements: RetentionEntitlementsReader;
  notices: Pick<PubSub, 'publish'>;
  mailer: RetentionMailer;
  /** Other lanes' policies, run after these. */
  extra?: readonly RetentionPolicy[];
  logger?: Logger;
  metrics?: Metrics;
}

/** Every policy, in run order. */
export function createRetentionPolicies(deps: RetentionPoliciesDeps): RetentionPolicy[] {
  const observability = {
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
  };
  return [
    createHistoryPolicy({
      store: deps.stores.history,
      state: deps.stores.state,
      cursor: deps.cursor,
      history: deps.history,
      ...(deps.snapshots === undefined ? {} : { snapshots: deps.snapshots }),
      entitlements: deps.entitlements,
      notices: deps.notices,
      mailer: deps.mailer,
      ...observability,
    }),
    createAuditPolicy({
      store: deps.stores.audit,
      state: deps.stores.state,
      cursor: deps.cursor,
      entitlements: deps.entitlements,
      ...observability,
    }),
    ...ROW_POLICIES.map((p) =>
      createRowPolicy({ id: p.id, owner: p.owner, guard: p.guard, store: deps.stores.rows[p.id] }),
    ),
    createTelemetryReportPolicy({
      store: deps.stores.telemetry,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    }),
    ...(deps.extra ?? []),
  ];
}
