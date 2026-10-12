/**
 * The API service's configuration (B102): every setting the entrypoint needs, read once.
 *
 * Composes the loaders of the lanes (base B004, token keys B017, pagination B012, rate limits
 * B023, status B033, PKCE B018, e-mail sign-in B014) and adds the few keys of the entrypoint
 * itself. Throws one `ConfigError` for a bad value; a missing optional section is `null`, and the
 * module list (`modules.ts`) skips what it needs.
 *
 * Owns: assembling the service's settings. Must not: read `process.env` except through the
 * loaders' default, or put a value in an error.
 */
import {
  baseConfig,
  defineConfig,
  envUrl,
  paginationConfig,
  rateLimitConfig,
  z,
  type BaseConfig,
  type Env,
  type PaginationConfig,
  type RateLimitConfig,
} from '@centcom/core';
import { loadMagicLinkConfig, type MagicLinkConfig } from './modules/auth/magic-link/config.js';
import { loadPkceConfig, type PkceConfig } from './modules/auth/pkce/config.js';
import { loadTokenKeys, type TokenKeys } from './modules/auth/tokens/index.js';
import { loadStatusConfig, type StatusConfig } from './modules/status/config.js';

/** The entrypoint's own keys. */
export const apiEnvSchema = z.object({
  DEV_MAILPIT_URL: envUrl({ protocols: ['http:', 'https:'], plain: true })
    .optional()
    .meta({
      description:
        'Development only: the Mailpit HTTP address (such as http://127.0.0.1:8025) that sign-in links are sent to. Setting it turns e-mail sign-in on; production mail goes through the email worker (not wired here yet).',
      example: 'http://127.0.0.1:8025',
    }),
  DEVICE_VERIFICATION_URI: envUrl({ protocols: ['https:', 'http:'], plain: true })
    .optional()
    .meta({
      description:
        'The address the terminal tells people to open to approve a sign-in; default https://centcom.dev/device. Set it to <PUBLIC_API_URL>/device for local development.',
      example: 'http://localhost:3000/device',
    }),
  RELAY_PUBLIC_URL: envUrl({ protocols: ['wss:', 'ws:'], plain: true })
    .optional()
    .meta({
      description:
        "The WebSocket address clients are told to connect to for sessions (the relay's /v1/ws). Setting it turns the session routes on; without it they are left out.",
      example: 'ws://localhost:8080/v1/ws',
    }),
  RELAY_REGION: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}$/, 'must be 2-32 characters of a-z, 0-9 and -')
    .default('local')
    .meta({
      description: 'The region name sessions get and the relay at RELAY_PUBLIC_URL serves.',
      example: 'local',
    }),
});

/** Everything the service reads from its environment. */
export interface ApiConfig {
  base: BaseConfig;
  keys: TokenKeys;
  pagination: PaginationConfig;
  rateLimit: RateLimitConfig;
  status: StatusConfig;
  pkce: PkceConfig;
  /** Null: e-mail sign-in is off (no mail transport is configured). */
  magicLink: MagicLinkConfig | null;
  /** Where sign-in mail goes in development; null: nowhere. */
  mailpitUrl: string | null;
  /** Overrides the default verification address (development). */
  verificationUri: string | null;
  /** Where the relay is and the region it serves; null: the session routes are off. */
  relay: { url: string; region: string } | null;
  /** Cookies are `Secure` only when the public URL is https. */
  secureCookies: boolean;
}

/** Reads and checks the whole configuration. Throws `ConfigError`. */
export function loadApiConfig(env?: Env): ApiConfig {
  const base = baseConfig(env);
  const own = defineConfig(apiEnvSchema, env);
  const mailpitUrl = own.DEV_MAILPIT_URL ?? null;
  return {
    base,
    keys: loadTokenKeys(env),
    pagination: paginationConfig(env),
    rateLimit: rateLimitConfig(base, env),
    status: loadStatusConfig(env),
    pkce: loadPkceConfig(env),
    magicLink: mailpitUrl === null ? null : loadMagicLinkConfig(env),
    mailpitUrl,
    verificationUri: own.DEVICE_VERIFICATION_URI ?? null,
    relay:
      own.RELAY_PUBLIC_URL === undefined
        ? null
        : { url: own.RELAY_PUBLIC_URL, region: own.RELAY_REGION },
    secureCookies: base.publicApiUrl.startsWith('https:'),
  };
}
