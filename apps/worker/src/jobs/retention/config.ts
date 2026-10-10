/**
 * Retention configuration (B090), read through the config loader (B004):
 *
 * - `RETENTION_DRY_RUN` (boolean; default true unless `NODE_ENV` is `production`): count what is
 *   due, delete and write nothing.
 * - `RETENTION_FORCE` (boolean; default false): ignore the fraction brake for a run (an operator
 *   sets it to let a large, expected purge through, such as the first run on old data).
 * - `RETENTION_MAX_DELETE_FRACTION` (default 0.2, above 0 and at most 1): the largest share of a
 *   table one run may delete before the policy aborts with `fraction_exceeded`.
 *
 * Owns: the keys, their defaults and checks. Must not: read the environment except through the
 * config loader.
 */
import { defineConfig, envBool, z, type Env } from '@centcom/core';
import type { RetentionRunConfig } from './runner.js';
import { DEFAULT_MAX_DELETE_FRACTION } from './policy.js';

const FRACTION = /^(?:0?\.\d{1,6}|1(?:\.0{1,6})?)$/;

/** The environment keys of the retention job. */
export const retentionEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  RETENTION_DRY_RUN: envBool().optional().meta({
    description:
      'Count what retention would delete, delete nothing. Default: on outside production.',
    example: 'true',
  }),
  RETENTION_FORCE: envBool()
    .default(false)
    .meta({ description: 'Let one run delete more than the brake allows.', example: 'false' }),
  RETENTION_MAX_DELETE_FRACTION: z
    .string()
    .regex(FRACTION, 'must be a decimal above 0 and at most 1, such as 0.2')
    .transform(Number)
    .pipe(z.number().gt(0).max(1))
    .default(DEFAULT_MAX_DELETE_FRACTION)
    .meta({
      description: 'Largest share of a table one retention run may delete.',
      example: '0.2',
    }),
});

/** Reads the keys (default: the process environment); a ConfigError naming a bad one. */
export function loadRetentionConfig(env?: Env): RetentionRunConfig {
  const v = defineConfig(retentionEnvSchema, env);
  return {
    dryRun: v.RETENTION_DRY_RUN ?? v.NODE_ENV?.trim() !== 'production',
    force: v.RETENTION_FORCE,
    maxDeleteFraction: v.RETENTION_MAX_DELETE_FRACTION,
  };
}
