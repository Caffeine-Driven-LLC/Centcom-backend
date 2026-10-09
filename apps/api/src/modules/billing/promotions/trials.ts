/**
 * Free trials (B079).
 *
 * - **`trialEligibility(workspaceId, userId)`** (for B071's checkout): one trial per workspace and
 *   per owner, TRIAL_DAYS long, of TRIAL_PLAN. Refused with `workspace_paid` while the workspace
 *   pays (active or past due) or after it did (canceled), and with `already_used` while it is in
 *   a trial or when it, the asking user or one of its owners had one (`billing_trials`).
 * - **`recordTrial(workspaceId, sub)`** keeps a trial once Stripe confirms it (the subscription is
 *   `trialing`), with every owner of the workspace at the time; nothing else grants or records
 *   one (guardrail). B072's handler calls it for every subscription it reconciles.
 * - **`trialWillEnd(workspaceId, sub)`** (B072's `customer.subscription.trial_will_end`, three
 *   days before the end): records the trial if it was missed, and emails the workspace's billing
 *   contact through B032 (`trial_ending`), once per subscription and trial end (the email's
 *   idempotency key). B072's handler announces `billing.subscription.updated` for the event.
 *
 * Owns: trial eligibility and history. Must not: start or extend a trial (Stripe and B071 do), or
 * mail anyone but the billing contact.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { StripeSub } from '../stripe/gateway.js';
import type { PaidPlan } from '../stripe/price-catalog.js';
import type { BillingRepository } from '../subscriptions/repository.js';
import type { PromotionConfig } from './config.js';
import type { TrialMail } from './ports.js';
import type { PromotionRepository } from './repository.js';
import { TRIAL_ENDING_TEMPLATE, TRIAL_ENDING_TEMPLATE_ID } from './trial-mail.js';

/** Whether a workspace may start a trial, and of what. */
export interface TrialEligibility {
  eligible: boolean;
  reason?: 'already_used' | 'workspace_paid';
  /** TRIAL_DAYS. */
  days: number;
  /** TRIAL_PLAN. */
  plan: PaidPlan;
}

/** What the trial service needs. */
export interface TrialServiceDeps {
  repository: PromotionRepository;
  billing: Pick<BillingRepository, 'findSubscription' | 'billingContact'>;
  config: Pick<PromotionConfig, 'trialDays' | 'trialPlan'>;
  /** B032's email service; without it no trial-ending email is sent. */
  mail?: TrialMail | null;
  logger?: Logger;
  metrics?: Metrics;
}

/** Statuses of a workspace that pays or paid. */
const PAYING: ReadonlySet<string> = new Set(['active', 'past_due']);

/** Free trials. */
export class TrialService {
  readonly #metrics: Metrics;

  constructor(private readonly deps: TrialServiceDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
    const mail = deps.mail;
    if (mail != null && !mail.templates.ids().includes(TRIAL_ENDING_TEMPLATE_ID)) {
      mail.templates.registerTemplate(TRIAL_ENDING_TEMPLATE_ID, TRIAL_ENDING_TEMPLATE);
    }
  }

  /** Whether `workspaceId` may start a trial, asked by `userId` (see the module comment). */
  async trialEligibility(workspaceId: string, userId: string): Promise<TrialEligibility> {
    const { config, billing, repository } = this.deps;
    const base = { days: config.trialDays, plan: config.trialPlan };
    const sub = await billing.findSubscription(workspaceId);
    if (sub !== null && PAYING.has(sub.status)) {
      return { eligible: false, reason: 'workspace_paid', ...base };
    }
    const owners = await repository.ownersOf(workspaceId);
    const users = [...new Set([userId, ...owners])];
    if (sub?.status === 'trialing' || (await repository.trialUsed(workspaceId, users))) {
      return { eligible: false, reason: 'already_used', ...base };
    }
    if (sub?.status === 'canceled') return { eligible: false, reason: 'workspace_paid', ...base };
    return { eligible: true, ...base };
  }

  /** Keeps `sub` as a trial of `workspaceId` if Stripe says it is trialing; whether it was new. */
  async recordTrial(workspaceId: string, sub: StripeSub): Promise<boolean> {
    if (sub.status !== 'trialing') return false;
    const owners = await this.deps.repository.ownersOf(workspaceId);
    const recorded = await this.deps.repository.recordTrial({
      stripeSubscriptionId: sub.id,
      workspaceId,
      ownerUserIds: owners,
      trialEnd: sub.trialEnd === null ? null : new Date(sub.trialEnd * 1000),
    });
    if (recorded) {
      this.#metrics.counter('trials_recorded_total').inc();
      this.deps.logger?.info({ workspace_id: workspaceId }, 'billing.trial_recorded');
    }
    return recorded;
  }

  /**
   * Stripe's `trial_will_end` for `sub` of `workspaceId`: records the trial and emails the billing
   * contact (once per subscription and trial end). Throws what the email service throws, so the
   * event is retried.
   */
  async trialWillEnd(workspaceId: string, sub: StripeSub): Promise<'sent' | 'skipped'> {
    await this.recordTrial(workspaceId, sub);
    const skip = (reason: string): 'skipped' => {
      this.#metrics.counter('trial_ending_emails_total', { outcome: reason }).inc();
      this.deps.logger?.info({ workspace_id: workspaceId, reason }, 'billing.trial_ending_skipped');
      return 'skipped';
    };
    if (sub.status !== 'trialing' || sub.trialEnd === null) return skip('not_trialing');
    const mail = this.deps.mail;
    if (mail == null) return skip('not_configured');
    const contact = await this.deps.billing.billingContact(workspaceId);
    if (contact === null) return skip('no_contact');
    await mail.send(
      TRIAL_ENDING_TEMPLATE_ID,
      contact.email,
      { workspaceName: contact.name, trialEnd: new Date(sub.trialEnd * 1000) },
      { idempotencyKey: `trial-ending-${sub.id}-${sub.trialEnd}` },
    );
    this.#metrics.counter('trial_ending_emails_total', { outcome: 'sent' }).inc();
    return 'sent';
  }
}
