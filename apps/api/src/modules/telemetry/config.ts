/**
 * Telemetry configuration (B085, CT-TELEMETRY).
 *
 * | Key | Default | |
 * |---|---|---|
 * | `TELEMETRY_RETENTION_DAYS` | 90 | Days raw events are kept; CT-TELEMETRY fixes it at 90, so any other value is refused. |
 * | `TELEMETRY_BATCH_MAX_EVENTS` | 100 | Most events in one batch (1 to 100); a larger batch is dropped whole. |
 * | `TELEMETRY_BATCH_MAX_BYTES` | 65536 | Largest body (1 KiB to 64 KiB); a larger one is dropped. |
 * | `TELEMETRY_IP_SALT` | random | Secret salt of the per-address rate-limit key; set it so every instance shares the limit. |
 *
 * Owns: reading and checking these keys.
 */
import { randomBytes } from 'node:crypto';
import { defineConfig, envInt, Secret, secretString, z, type Env } from '@centcom/core';

/** CT-TELEMETRY rule 5: raw events are kept 90 days. */
export const TELEMETRY_RETENTION_DAYS = 90;
/** CT-TELEMETRY rule 3. */
export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_BYTES = 64 * 1024;

/** The environment keys of telemetry. */
export const telemetryEnvSchema = z.object({
  TELEMETRY_RETENTION_DAYS: envInt({ min: TELEMETRY_RETENTION_DAYS, max: TELEMETRY_RETENTION_DAYS })
    .default(TELEMETRY_RETENTION_DAYS)
    .meta({ description: 'Days raw telemetry is kept; must be 90 (CT-TELEMETRY).' }),
  TELEMETRY_BATCH_MAX_EVENTS: envInt({ min: 1, max: MAX_BATCH_EVENTS })
    .default(MAX_BATCH_EVENTS)
    .meta({ description: 'Most events in one telemetry batch.' }),
  TELEMETRY_BATCH_MAX_BYTES: envInt({ min: 1024, max: MAX_BATCH_BYTES })
    .default(MAX_BATCH_BYTES)
    .meta({ description: 'Largest telemetry batch body, in bytes.' }),
  TELEMETRY_IP_SALT: secretString(z.string().min(32)).optional().meta({
    description:
      'Salt (32+ characters) of the hashed per-address rate-limit keys; random per process when unset.',
  }),
});

/** The checked configuration. */
export interface TelemetryConfig {
  retentionDays: number;
  maxEvents: number;
  maxBytes: number;
  ipSalt: Secret<string>;
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadTelemetryConfig(env?: Env): TelemetryConfig {
  const v = defineConfig(telemetryEnvSchema, env);
  return {
    retentionDays: v.TELEMETRY_RETENTION_DAYS,
    maxEvents: v.TELEMETRY_BATCH_MAX_EVENTS,
    maxBytes: v.TELEMETRY_BATCH_MAX_BYTES,
    ipSalt: v.TELEMETRY_IP_SALT ?? new Secret(randomBytes(32).toString('base64url')),
  };
}
