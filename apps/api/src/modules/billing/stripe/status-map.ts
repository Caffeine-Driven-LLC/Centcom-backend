/**
 * Stripe subscription status → the contract's (B070, CT-ENTITLEMENTS §4 statuses):
 *
 * | Stripe | Contract |
 * | --- | --- |
 * | `active` | `active` |
 * | `trialing` | `trialing` |
 * | `past_due`, `unpaid` | `past_due` |
 * | `canceled` | `canceled` |
 * | `incomplete`, `incomplete_expired`, `paused` | `none` |
 * | anything else (a status Stripe adds later) | `none`, with a warning |
 *
 * Owns: the mapping. Must not: decide entitlements (B069 does, from the mapped status).
 */
import type { Logger } from '@centcom/core';

/** A subscription status as the contract names it. */
export type ContractStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';

/** The statuses Stripe documents for the pinned API version, mapped. */
export const STRIPE_STATUS_MAP: Readonly<Record<string, ContractStatus>> = Object.freeze({
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'none',
  incomplete_expired: 'none',
  paused: 'none',
});

/** The contract status of Stripe's `status`; an unknown one is `none`, logged as a warning. */
export function mapStripeStatus(status: string, logger?: Logger): ContractStatus {
  const mapped = Object.hasOwn(STRIPE_STATUS_MAP, status) ? STRIPE_STATUS_MAP[status] : undefined;
  if (mapped !== undefined) return mapped;
  logger?.warn(
    { stripe_status: /^[a-z_]{1,40}$/.test(status) ? status : 'unprintable' },
    'billing.unknown_stripe_status',
  );
  return 'none';
}
