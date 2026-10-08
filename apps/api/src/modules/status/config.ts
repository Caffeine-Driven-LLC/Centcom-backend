/**
 * Status configuration (B086, CT-STATUS).
 *
 * | Key | Default | |
 * |---|---|---|
 * | `STATUS_COMPONENTS` | `[]` | JSON array of components: `{id, name, probe?}`, the probe `{url}` (a GET answered 2xx within 2 s) or `{heartbeat_key, max_age_s?}` (a Redis key holding a recent epoch-ms time). Without a probe a component is `operational`. At most 50. |
 * | `MIN_CLIENT_VERSION` | `0.0.0` | `min_client_version` when Redis has no `status:min_client_version`. |
 * | `READYZ_TIMEOUT_MS` | `1000` | How long each `/readyz` check may take (100 to 5 000). |
 * | `EXPECTED_MIGRATION_VERSION` | this build's newest migration | The migration version `/readyz` requires. |
 *
 * Probe URLs and heartbeat keys are internal and never appear in a response. Owns: reading and
 * checking these keys.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';
import { expectedMigrationVersion } from '@centcom/db';
import { parseSemver } from '../flags/version.js';

/** Components the feed lists, at most. */
export const MAX_COMPONENTS = 50;

/** How a component is probed. */
export type ComponentProbe = { url: string } | { heartbeat_key: string; max_age_s: number } | null;

/** A component of the feed. */
export interface StatusComponent {
  id: string;
  name: string;
  probe: ComponentProbe;
}

const componentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    name: z.string().min(1).max(60),
    probe: z
      .union([
        z.object({ url: z.url({ protocol: /^https?$/ }) }).strict(),
        z
          .object({
            heartbeat_key: z.string().regex(/^[a-z0-9:_.-]{1,100}$/),
            max_age_s: z.number().int().min(1).max(3600).default(60),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

/** STATUS_COMPONENTS: a JSON array of components with unique ids. */
export const statusComponentsSchema = z.string().transform((value, ctx): StatusComponent[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be a JSON array' });
    return z.NEVER;
  }
  const checked = z.array(componentSchema).max(MAX_COMPONENTS).safeParse(parsed);
  if (!checked.success) {
    ctx.addIssue({
      code: 'custom',
      message: `must be an array of at most ${MAX_COMPONENTS} components {id, name, probe?}`,
    });
    return z.NEVER;
  }
  const ids = checked.data.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'a component id is given twice' });
    return z.NEVER;
  }
  return checked.data.map((c) => ({ id: c.id, name: c.name, probe: c.probe ?? null }));
});

/** The environment keys of the status feed and readiness. */
export const statusEnvSchema = z.object({
  STATUS_COMPONENTS: statusComponentsSchema
    .default([])
    .meta({ description: 'Components of the status feed (JSON array of {id, name, probe?}).' }),
  MIN_CLIENT_VERSION: z
    .string()
    .refine((v) => parseSemver(v) !== null, 'must be a semantic version')
    .default('0.0.0')
    .meta({ description: 'min_client_version when Redis has none from the release service.' }),
  READYZ_TIMEOUT_MS: envInt({ min: 100, max: 5000 })
    .default(1000)
    .meta({ description: 'How long each /readyz check may take, in milliseconds.' }),
  EXPECTED_MIGRATION_VERSION: z
    .string()
    .regex(/^\d{14}$/, 'must be a 14-digit migration version')
    .optional()
    .meta({ description: "The migration version /readyz requires; default this build's newest." }),
});

/** The checked configuration. */
export interface StatusConfig {
  components: readonly StatusComponent[];
  minClientVersion: string;
  readyzTimeoutMs: number;
  /** Null when the build has no migrations. */
  expectedMigrationVersion: string | null;
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadStatusConfig(env?: Env): StatusConfig {
  const v = defineConfig(statusEnvSchema, env);
  return {
    components: v.STATUS_COMPONENTS,
    minClientVersion: v.MIN_CLIENT_VERSION,
    readyzTimeoutMs: v.READYZ_TIMEOUT_MS,
    expectedMigrationVersion: v.EXPECTED_MIGRATION_VERSION ?? (expectedMigrationVersion() || null),
  };
}
