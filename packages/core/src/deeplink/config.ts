/**
 * Deep-link configuration (B033): the web origin links are built on and read from (WEB_BASE_URL,
 * `https://centcom.dev` by default). It must be https with nothing but an origin, so a bad value
 * stops the process at boot rather than producing links elsewhere.
 *
 * Owns: reading and checking the key.
 */
import { z } from 'zod';
import { defineConfig, type Env } from '../config/define.js';
import { DEFAULT_WEB_BASE_URL, webOrigin } from './urls.js';

/** The deep-link environment keys (rendered into docs/config.md and .env.example). */
export const deeplinkEnvSchema = z.object({
  WEB_BASE_URL: z
    .string()
    .refine(
      (value) => webOrigin(value) !== null,
      'must be an https origin with no path, query or fragment',
    )
    .default(DEFAULT_WEB_BASE_URL)
    .meta({
      description: 'Web origin of join, invite, session and billing links (https only).',
      example: DEFAULT_WEB_BASE_URL,
      envType: 'URL (https://)',
    }),
});

/** Checked deep-link settings. */
export interface DeeplinkConfig {
  /** The origin: lower case, no trailing slash. */
  webBase: string;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function deeplinkConfig(env?: Env): DeeplinkConfig {
  const { WEB_BASE_URL } = defineConfig(deeplinkEnvSchema, env);
  return { webBase: webOrigin(WEB_BASE_URL) ?? DEFAULT_WEB_BASE_URL };
}
