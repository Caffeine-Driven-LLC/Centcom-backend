/**
 * Telemetry configuration (B093).
 *
 * | Key | Default | |
 * |---|---|---|
 * | `OTEL_ENABLED` | `true` | `false` turns metrics and traces off (local and dev). Never on under tests. |
 * | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | The collector's OTLP/HTTP endpoint. |
 * | `OTEL_SAMPLE_RATIO` | `0.05` | Share of traces kept at the source (0 to 1). |
 *
 * Telemetry is off whenever NODE_ENV is `test` (or Vitest runs), whatever OTEL_ENABLED says: tests
 * never send telemetry.
 *
 * Owns: reading and checking these keys.
 */
import { defineConfig, envBool, envUrl, z, type Env } from '../config/index.js';

/** The environment keys of telemetry. */
export const otelEnvSchema = z.object({
  OTEL_ENABLED: envBool().default(true).meta({ description: 'Export metrics and traces.' }),
  OTEL_EXPORTER_OTLP_ENDPOINT: envUrl({ protocols: ['http:', 'https:'], plain: true })
    .default('http://localhost:4318')
    .meta({ description: "The collector's OTLP/HTTP endpoint." }),
  OTEL_SAMPLE_RATIO: z
    .string()
    .regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be a number from 0 to 1')
    .transform(Number)
    .default(0.05)
    .meta({ description: 'Share of traces kept at the source (0 to 1).' }),
  NODE_ENV: z.string().optional(),
  VITEST: z.string().optional(),
});

/** The checked configuration. */
export interface OtelConfig {
  enabled: boolean;
  /** No trailing slash; signals go to `/v1/metrics` and `/v1/traces` under it. */
  endpoint: string;
  sampleRatio: number;
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadOtelConfig(env?: Env): OtelConfig {
  const v = defineConfig(otelEnvSchema, env);
  const underTest = v.NODE_ENV === 'test' || v.VITEST !== undefined;
  return {
    enabled: v.OTEL_ENABLED && !underTest,
    endpoint: v.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, ''),
    sampleRatio: v.OTEL_SAMPLE_RATIO,
  };
}
