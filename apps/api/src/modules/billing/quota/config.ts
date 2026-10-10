/**
 * Quota signal configuration (B076), read through the config loader (B004):
 *
 * - `QUOTA_WARN_PCT` (80): the warning threshold. CT-ENTITLEMENTS §5 fixes it at 80, so any other
 *   value is refused rather than obeyed.
 * - `QUOTA_EVAL_DEBOUNCE_MS` (default 10 000, 0 to 60 000): how long a workspace's evaluation waits
 *   after usage moved, so a burst of aggregate updates makes one evaluation.
 * - `QUOTA_SWEEP_INTERVAL_S` (default 60, 10 to 3 600): how often the sweep runs.
 *
 * Owns: the keys, their defaults and checks. Must not: read the environment except through the
 * config loader.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';
import { WARN_PCT } from './levels.js';

/** The default debounce of an evaluation. */
export const DEFAULT_QUOTA_EVAL_DEBOUNCE_MS = 10_000;
/** The default sweep interval. */
export const DEFAULT_QUOTA_SWEEP_INTERVAL_S = 60;

/** The environment keys of quota signals. */
export const quotaSignalEnvSchema = z.object({
  QUOTA_WARN_PCT: envInt({ min: WARN_PCT, max: WARN_PCT }).default(WARN_PCT).meta({
    description: 'Quota warning threshold in percent; fixed at 80 by contract.',
    example: '80',
  }),
  QUOTA_EVAL_DEBOUNCE_MS: envInt({ min: 0, max: 60_000 })
    .default(DEFAULT_QUOTA_EVAL_DEBOUNCE_MS)
    .meta({
      description: 'How long a workspace’s quota evaluation waits after its usage moved, in ms.',
      example: '10000',
    }),
  QUOTA_SWEEP_INTERVAL_S: envInt({ min: 10, max: 3600 })
    .default(DEFAULT_QUOTA_SWEEP_INTERVAL_S)
    .meta({ description: 'Seconds between quota signal sweeps.', example: '60' }),
});

/** Checked configuration. */
export interface QuotaSignalConfig {
  warnPct: number;
  debounceMs: number;
  sweepIntervalS: number;
}

/** Reads the keys (default: the process environment); a ConfigError naming a bad one. */
export function loadQuotaSignalConfig(env?: Env): QuotaSignalConfig {
  const v = defineConfig(quotaSignalEnvSchema, env);
  return {
    warnPct: v.QUOTA_WARN_PCT,
    debounceMs: v.QUOTA_EVAL_DEBOUNCE_MS,
    sweepIntervalS: v.QUOTA_SWEEP_INTERVAL_S,
  };
}
