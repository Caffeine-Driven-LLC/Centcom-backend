/**
 * Configuration of trials and promotions (B079):
 *
 * - TRIAL_DAYS (default 14, 1 to 90): how long a trial lasts, for B071's checkout.
 * - TRIAL_PLAN (default `team`; `pro` or `team`, a paid plan of B069's default plans): the plan a
 *   trial is of.
 * - COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR (default 10, 1 to 1 000): redeem attempts allowed
 *   per workspace, and per client address, per hour (valid or not).
 *
 * Owns: the keys, their defaults and checks. Must not: read the environment except through the
 * config loader.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';
import { PAID_PLANS, type PaidPlan } from '../stripe/price-catalog.js';

/** The default trial length, in days. */
export const DEFAULT_TRIAL_DAYS = 14;
/** The default redeem attempts per workspace (and per address) per hour. */
export const DEFAULT_REDEEM_RATE = 10;
/** The redeem limit's window. */
export const REDEEM_WINDOW_S = 3600;

/** The environment keys of trials and promotions. */
export const promotionEnvSchema = z.object({
  TRIAL_DAYS: envInt({ min: 1, max: 90 })
    .default(DEFAULT_TRIAL_DAYS)
    .meta({ description: 'How long a free trial lasts, in days.', example: '14' }),
  TRIAL_PLAN: z
    .enum(PAID_PLANS)
    .default('team')
    .meta({ description: 'The paid plan a free trial is of (pro or team).', example: 'team' }),
  COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR: envInt({ min: 1, max: 1000 })
    .default(DEFAULT_REDEEM_RATE)
    .meta({
      description:
        'Coupon redeem attempts allowed per workspace, and per client address, per hour.',
      example: '10',
    }),
});

/** Checked configuration. */
export interface PromotionConfig {
  trialDays: number;
  trialPlan: PaidPlan;
  redeemRatePerHour: number;
}

/** Reads the keys (default: the process environment); a ConfigError naming a bad one. */
export function loadPromotionConfig(env?: Env): PromotionConfig {
  const v = defineConfig(promotionEnvSchema, env);
  return {
    trialDays: v.TRIAL_DAYS,
    trialPlan: v.TRIAL_PLAN,
    redeemRatePerHour: v.COUPON_REDEEM_RATE_PER_WORKSPACE_PER_HOUR,
  };
}
