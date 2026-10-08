/**
 * API-key configuration (B019): the pepper every key is hashed with, read through the config
 * loader (B004) from secrets only.
 *
 * `API_KEY_PEPPER` must hold at least 32 bytes. A database copy without it cannot check a guessed
 * key against `api_keys.key_hash`. Changing it invalidates every key (each must be made again), so
 * it is set once per environment and kept with the other secrets.
 *
 * Owns: reading the pepper. Must not: start without one (the API refuses: ConfigError), or put it
 * in an error.
 */
import { defineConfig, secretString, z, type Env, type Secret } from '@centcom/core';

/** The shortest pepper accepted, in bytes. */
export const MIN_PEPPER_BYTES = 32;

/** The environment keys of API keys. */
export const apiKeyEnvSchema = z.object({
  API_KEY_PEPPER: secretString(
    z.string().refine((value) => Buffer.byteLength(value, 'utf8') >= MIN_PEPPER_BYTES, {
      message: `must be at least ${MIN_PEPPER_BYTES} bytes`,
    }),
  ).meta({
    description:
      'Server-side pepper of API key hashes (sha256(pepper ‖ key)); at least 32 bytes of random. Changing it invalidates every key.',
    example: 'change-me-to-at-least-32-random-bytes',
  }),
});

/** The checked configuration. */
export interface ApiKeyConfig {
  pepper: Secret<string>;
}

/** Reads API_KEY_PEPPER from `env` (default the process environment); throws ConfigError. */
export function apiKeyConfig(env?: Env): ApiKeyConfig {
  return { pepper: defineConfig(apiKeyEnvSchema, env).API_KEY_PEPPER };
}
