/**
 * Guard configuration (B101): `SECRET_GUARD_ENABLED` (default true; false is allowed only with
 * NODE_ENV=test), `SECRET_GUARD_MAX_BODY_BYTES` (largest REST body scanned) and
 * `SECRET_GUARD_ALLOW_FILE` (path of the allow-list JSON, optional).
 *
 * Owns: reading and checking these keys. Must not: let the guard be switched off outside tests.
 */
import { ConfigError } from '../config/define.js';
import { defineConfig, envBool, envInt, type Env } from '../config/define.js';
import { NODE_ENVS } from '../config/base.js';
import { z } from 'zod';
import { EMPTY_ALLOW_LIST, loadAllowListFile, type AllowList } from './allow.js';
import { DEFAULT_MAX_BODY_BYTES } from './fastify.js';

/** The guard's environment keys (rendered into docs/config.md and .env.example). */
export const secretGuardEnvSchema = z.object({
  SECRET_GUARD_ENABLED: envBool().default(true).meta({
    description:
      'Scan requests, frames, telemetry and logs for provider credentials. May be false only when NODE_ENV=test.',
    example: 'true',
  }),
  SECRET_GUARD_MAX_BODY_BYTES: envInt({ min: 1_024, max: 16_777_216 })
    .default(DEFAULT_MAX_BODY_BYTES)
    .meta({
      description: 'Largest request body the REST guard scans; a larger one is rejected with 413.',
      example: '1048576',
    }),
  SECRET_GUARD_ALLOW_FILE: z.string().min(1).optional().meta({
    description:
      'Path of the allow-list JSON (secret-guard.allow.json): pattern id plus location, with a reason and an expiry.',
    example: '',
  }),
});

/** Checked settings. */
export interface SecretGuardConfig {
  enabled: boolean;
  maxBodyBytes: number;
  allow: AllowList;
}

/** Reads the settings. Throws `ConfigError` (and `AllowListError` for a bad allow-list file). */
export function secretGuardConfig(env?: Env, now?: Date): SecretGuardConfig {
  const v = defineConfig(
    secretGuardEnvSchema.extend({ NODE_ENV: z.enum(NODE_ENVS).default('development') }),
    env,
  );
  if (!v.SECRET_GUARD_ENABLED && v.NODE_ENV !== 'test') {
    throw new ConfigError([
      { key: 'SECRET_GUARD_ENABLED', problem: 'may be false only when NODE_ENV=test' },
    ]);
  }
  return {
    enabled: v.SECRET_GUARD_ENABLED,
    maxBodyBytes: v.SECRET_GUARD_MAX_BODY_BYTES,
    allow:
      v.SECRET_GUARD_ALLOW_FILE === undefined
        ? EMPTY_ALLOW_LIST
        : loadAllowListFile(v.SECRET_GUARD_ALLOW_FILE, now),
  };
}
