/**
 * Feature flag configuration (B083).
 *
 * | Key | Default | |
 * |---|---|---|
 * | `FLAGS_TTL_S` | 60 | `ttl_s` and `max-age` of an authenticated `GET /v1/flags` (5 to 3 600). |
 * | `FLAGS_MAX_COUNT` | 500 | Most flags stored (1 to 500). |
 * | `FLAGS_MAX_VALUE_BYTES` | 2048 | Largest value or default, as compact JSON (16 to 2 048). |
 *
 * Owns: reading and checking these keys.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** The card's limits, which the configuration may lower but not raise. */
export const MAX_FLAG_COUNT = 500;
export const MAX_FLAG_VALUE_BYTES = 2048;

/** The environment keys of feature flags. */
export const flagsEnvSchema = z.object({
  FLAGS_TTL_S: envInt({ min: 5, max: 3600 })
    .default(60)
    .meta({ description: 'How long clients may cache their flags, in seconds (authenticated).' }),
  FLAGS_MAX_COUNT: envInt({ min: 1, max: MAX_FLAG_COUNT })
    .default(MAX_FLAG_COUNT)
    .meta({ description: 'Most feature flags that may be stored.' }),
  FLAGS_MAX_VALUE_BYTES: envInt({ min: 16, max: MAX_FLAG_VALUE_BYTES })
    .default(MAX_FLAG_VALUE_BYTES)
    .meta({ description: 'Largest flag value or default, in bytes of compact JSON.' }),
});

/** The checked configuration. */
export interface FlagsConfig {
  ttlS: number;
  maxCount: number;
  maxValueBytes: number;
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadFlagsConfig(env?: Env): FlagsConfig {
  const v = defineConfig(flagsEnvSchema, env);
  return {
    ttlS: v.FLAGS_TTL_S,
    maxCount: v.FLAGS_MAX_COUNT,
    maxValueBytes: v.FLAGS_MAX_VALUE_BYTES,
  };
}
