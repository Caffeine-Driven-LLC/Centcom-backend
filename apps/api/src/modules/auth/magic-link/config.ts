/**
 * E-mail sign-in configuration (B014): how long a link lasts (MAGIC_LINK_TTL_S, 15 minutes by
 * default), the public base URL links point at (MAGIC_LINK_BASE_URL: where `/login/email/verify`
 * is served), and the `return_to` allow-list it shares with social login
 * (LOGIN_RETURN_TO_ALLOWLIST, B015).
 *
 * Owns: reading and checking these keys. Must not: accept a base URL with credentials, a query or
 * a fragment.
 */
import { defineConfig, envInt, envUrl, z, type Env } from '@centcom/core';
import { returnToAllowlistSchema, returnToPolicy, type ReturnToPolicy } from '../return-to.js';

/** The link lifetime when none is configured. */
export const DEFAULT_MAGIC_LINK_TTL_S = 900;

/** The e-mail sign-in environment keys. */
export const magicLinkEnvSchema = z.object({
  MAGIC_LINK_TTL_S: envInt({ min: 60, max: 3600 }).default(DEFAULT_MAGIC_LINK_TTL_S).meta({
    description: 'How long an e-mailed sign-in link works, in seconds.',
    example: '900',
  }),
  MAGIC_LINK_BASE_URL: envUrl({ protocols: ['https:', 'http:'], plain: true }).meta({
    description: 'Public base URL of the API; links are <base>/login/email/verify?t=<token>.',
    example: 'http://localhost:3000',
  }),
  LOGIN_RETURN_TO_ALLOWLIST: returnToAllowlistSchema.meta({
    description:
      'Comma-separated URLs a login may return to (exact match); the first is the default.',
    example: 'http://localhost:5173/',
  }),
});

/** Checked e-mail sign-in settings. */
export interface MagicLinkConfig {
  ttlS: number;
  /** Without a trailing slash. */
  baseUrl: string;
  returnTo: ReturnToPolicy;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadMagicLinkConfig(env?: Env): MagicLinkConfig {
  const values = defineConfig(magicLinkEnvSchema, env);
  return {
    ttlS: values.MAGIC_LINK_TTL_S,
    baseUrl: values.MAGIC_LINK_BASE_URL.replace(/\/+$/, ''),
    returnTo: returnToPolicy(values.LOGIN_RETURN_TO_ALLOWLIST),
  };
}
