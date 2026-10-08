/**
 * Handshake configuration (B038): where the API's signing keys are (`RELAY_JWKS_URL`), the oldest
 * client accepted (`RELAY_MIN_CLIENT_VERSION`, semver) and the capabilities this relay offers
 * (`RELAY_CAPS`). Every key has a default; an invalid value is a ConfigError and the relay refuses
 * to start.
 *
 * Owns: reading and checking these keys. Must not: accept a JWKS URL with credentials or a query.
 */
import { defineConfig, envUrl, z, type Env } from '@centcom/core';
import { parseVersion } from './negotiate.js';

/** The API's JWKS in production. */
export const DEFAULT_JWKS_URL = 'https://api.centcom.dev/.well-known/jwks.json';
/** Every client version is accepted by default. */
export const DEFAULT_MIN_CLIENT_VERSION = '0.0.0';
/** CT-VER's capabilities the relay offers by default. */
export const DEFAULT_RELAY_CAPS = 'resume,cursor.coalesce';
/** A capability name. */
const CAP = /^[a-z0-9._-]{1,32}$/;

/** The environment keys of the handshake. */
export const handshakeEnvSchema = z.object({
  RELAY_JWKS_URL: envUrl({ protocols: ['https:', 'http:'], plain: true })
    .default(DEFAULT_JWKS_URL)
    .meta({
      description: "The API's JWKS (`/.well-known/jwks.json`), which verifies relay tickets.",
      example: 'http://localhost:3000/.well-known/jwks.json',
    }),
  RELAY_MIN_CLIENT_VERSION: z
    .string()
    .default(DEFAULT_MIN_CLIENT_VERSION)
    .refine((value) => parseVersion(value) !== undefined, 'must be a semver version (1.2.3)')
    .meta({
      description: 'Clients older than this are refused with close 4426 (client_too_old).',
      example: '1.0.0',
    }),
  RELAY_CAPS: z
    .string()
    .default(DEFAULT_RELAY_CAPS)
    .transform((value, ctx): string[] => {
      const caps = value
        .split(',')
        .map((cap) => cap.trim())
        .filter((cap) => cap !== '');
      if (caps.length > 16 || !caps.every((cap) => CAP.test(cap))) {
        ctx.addIssue({
          code: 'custom',
          message: 'must list at most 16 capability names of a-z, 0-9, . _ and -',
        });
        return z.NEVER;
      }
      return [...new Set(caps)];
    })
    .meta({
      description: 'Comma-separated capabilities the relay offers (CT-VER).',
      example: 'resume,cursor.coalesce',
    }),
});

/** Checked handshake settings. */
export interface HandshakeConfig {
  jwksUrl: string;
  minClientVersion: string;
  caps: readonly string[];
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadHandshakeConfig(env?: Env): HandshakeConfig {
  const values = defineConfig(handshakeEnvSchema, env);
  return {
    jwksUrl: values.RELAY_JWKS_URL,
    minClientVersion: values.RELAY_MIN_CLIENT_VERSION,
    caps: values.RELAY_CAPS,
  };
}
