/**
 * Configuration of dunning (B078):
 *
 * - DUNNING_GRACE_DAYS (default 7, must be 7): the grace a failed payment keeps the plan.
 *   CT-ENTITLEMENTS fixes it at 7 days; the key exists so a deployment that sets anything else
 *   fails at start instead of silently disagreeing with B069's resolver.
 * - DUNNING_WINDDOWN_MIN (default 10, must be 10): how long live hosted sessions keep running
 *   after a workspace drops to `none` (CT-ENTITLEMENTS §4 "end after 10 min").
 *
 * Owns: the keys, their defaults and checks. Must not: read the environment except through the
 * config loader.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';
import { GRACE_DAYS } from '../../entitlements/resolve.js';

/** CT-ENTITLEMENTS: live hosted sessions end this many minutes after the drop to `none`. */
export const WINDDOWN_MIN = 10;

/** The environment keys of dunning. */
export const dunningEnvSchema = z.object({
  DUNNING_GRACE_DAYS: envInt({ min: GRACE_DAYS, max: GRACE_DAYS }).default(GRACE_DAYS).meta({
    description: 'Grace days of a failed payment (CT-ENTITLEMENTS: exactly 7).',
    example: '7',
  }),
  DUNNING_WINDDOWN_MIN: envInt({ min: WINDDOWN_MIN, max: WINDDOWN_MIN })
    .default(WINDDOWN_MIN)
    .meta({
      description:
        'Minutes live hosted sessions keep running after the drop to none (CT-ENTITLEMENTS: 10).',
      example: '10',
    }),
});

/** Checked configuration. */
export interface DunningConfig {
  graceDays: number;
  windDownMs: number;
}

/** Reads the keys (default: the process environment); a ConfigError naming a bad one. */
export function loadDunningConfig(env?: Env): DunningConfig {
  const v = defineConfig(dunningEnvSchema, env);
  return { graceDays: v.DUNNING_GRACE_DAYS, windDownMs: v.DUNNING_WINDDOWN_MIN * 60 * 1000 };
}
