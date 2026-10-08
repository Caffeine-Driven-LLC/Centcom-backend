/**
 * Webhook configuration (B081), read through the config loader (B004):
 *
 * - `WEBHOOK_SECRET_KEY` (required): the AES-256 key (32 bytes, base64) that seals endpoint signing
 *   secrets at rest.
 * - `WEBHOOK_ALLOW_LOOPBACK` (test mode only): lets endpoints be `http://127.0.0.1` / `http://[::1]`
 *   / `localhost` (CT-WEBHOOKS "except localhost in test mode"). Refused when `NODE_ENV` is
 *   `production` (stage and prod).
 *
 * Owns: reading and checking these keys. Must not: put a key in an error or a log.
 */
import {
  ConfigError,
  defineConfig,
  NODE_ENVS,
  Secret,
  secretString,
  z,
  type Env,
} from '@centcom/core';

/** The environment keys of webhooks. */
export const webhookEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  WEBHOOK_SECRET_KEY: secretString().meta({
    description: 'AES-256 key (32 bytes, base64) sealing webhook signing secrets at rest.',
  }),
  WEBHOOK_ALLOW_LOOPBACK: z
    .enum(['true', 'false'])
    .default('false')
    .meta({ description: 'Test mode: allow loopback http endpoints. Refused in production.' }),
});

/** Webhook settings. */
export interface WebhookConfig {
  secretKey: Secret<Uint8Array>;
  allowLoopback: boolean;
}

/** Reads the webhook keys; a ConfigError naming the key for a bad key or loopback in production. */
export function loadWebhookConfig(env?: Env): WebhookConfig {
  const v = defineConfig(webhookEnvSchema, env);
  const key = Buffer.from(v.WEBHOOK_SECRET_KEY.reveal(), 'base64');
  const issues: { key: string; problem: string }[] = [];
  if (key.length !== 32) {
    issues.push({ key: 'WEBHOOK_SECRET_KEY', problem: 'must be 32 bytes, base64' });
  }
  const allowLoopback = v.WEBHOOK_ALLOW_LOOPBACK === 'true';
  if (allowLoopback && v.NODE_ENV === 'production') {
    issues.push({
      key: 'WEBHOOK_ALLOW_LOOPBACK',
      problem: 'is test mode only; refused in production',
    });
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return { secretKey: new Secret(new Uint8Array(key)), allowLoopback };
}
