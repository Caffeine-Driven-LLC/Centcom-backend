/**
 * Admin API configuration (B087).
 *
 * | Key | Default | |
 * |---|---|---|
 * | `ADMIN_API_ENABLED` | `false` | Starts the admin listener; without it the admin API does not exist. |
 * | `ADMIN_API_PORT` | `8081` | Its port: never the public API's. |
 * | `ADMIN_ALLOWED_CIDRS` | (none) | Comma-separated CIDR blocks whose connections are accepted; required when enabled. |
 *
 * Fixed: 60 calls a minute per staff user, a 5 s staff-role cache, `/internal/admin/v1`.
 *
 * Owns: reading and checking these keys. Must not: start the listener without an allowlist.
 */
import { defineConfig, envBool, envInt, z, type Env } from '@centcom/core';
import { parseCidr, type Cidr } from './cidr.js';

/** Where the admin routes live, on the admin listener only. */
export const ADMIN_BASE = '/internal/admin/v1';
/** Calls a staff user may make in ADMIN_RATE_WINDOW_S. */
export const ADMIN_RATE_LIMIT = 60;
/** The rate limit's window, in seconds. */
export const ADMIN_RATE_WINDOW_S = 60;
/** How long a staff role is cached, at most (the staff table is checked on every call). */
export const STAFF_CACHE_TTL_MS = 5_000;
/** The default admin port. */
export const DEFAULT_ADMIN_API_PORT = 8081;

/** ADMIN_ALLOWED_CIDRS: comma-separated CIDR blocks. */
export const allowedCidrsSchema = z.string().transform((value, ctx): Cidr[] => {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const cidrs: Cidr[] = [];
  for (const part of parts) {
    const cidr = parseCidr(part);
    if (cidr === null) {
      ctx.addIssue({ code: 'custom', message: 'must be comma-separated CIDR blocks' });
      return z.NEVER;
    }
    cidrs.push(cidr);
  }
  return cidrs;
});

/** The environment keys of the admin API. */
export const adminEnvSchema = z
  .object({
    ADMIN_API_ENABLED: envBool()
      .default(false)
      .meta({ description: 'Start the internal admin API listener.' }),
    ADMIN_API_PORT: envInt({ min: 1, max: 65535 })
      .default(DEFAULT_ADMIN_API_PORT)
      .meta({ description: "The admin listener's port; never the public API's." }),
    ADMIN_ALLOWED_CIDRS: allowedCidrsSchema
      .default([])
      .meta({ description: 'CIDR blocks the admin listener accepts connections from.' }),
  })
  .superRefine((v, ctx) => {
    if (v.ADMIN_API_ENABLED && v.ADMIN_ALLOWED_CIDRS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_ALLOWED_CIDRS'],
        message: 'is required when ADMIN_API_ENABLED is true',
      });
    }
  });

/** The checked configuration. */
export interface AdminConfig {
  enabled: boolean;
  port: number;
  allowedCidrs: readonly Cidr[];
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadAdminConfig(env?: Env): AdminConfig {
  const v = defineConfig(adminEnvSchema, env);
  return {
    enabled: v.ADMIN_API_ENABLED,
    port: v.ADMIN_API_PORT,
    allowedCidrs: v.ADMIN_ALLOWED_CIDRS,
  };
}
