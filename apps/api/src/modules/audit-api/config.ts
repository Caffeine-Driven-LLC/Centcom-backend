/**
 * Audit API configuration (B082): the export limits and the S3-compatible object store exports are
 * written to (R2 in production, MinIO in development).
 *
 * | Key | Default | |
 * |---|---|---|
 * | `AUDIT_EXPORT_MAX_ROWS` | 1 000 000 | Most events one export holds (1 to 1 000 000). |
 * | `AUDIT_EXPORT_URL_TTL_S` | 900 | Lifetime of a download URL, seconds (1 to 900). |
 * | `AUDIT_EXPORT_RETAIN_H` | 24 | Hours an export file is kept after it is written (1 to 168). |
 * | `OBJECT_STORE_ENDPOINT` | | `https://` (or `http://`) base URL of the S3 API. |
 * | `OBJECT_STORE_REGION` | `us-east-1` | Signing region (`auto` for R2). |
 * | `OBJECT_STORE_BUCKET` | | The bucket exports are written to. |
 * | `OBJECT_STORE_ACCESS_KEY_ID` | | Secret. |
 * | `OBJECT_STORE_SECRET_ACCESS_KEY` | | Secret. |
 *
 * The `OBJECT_STORE_*` keys are `@centcom/storage`'s (`objectStoreEnvShape`), shared with history.
 *
 * Owns: reading and checking these keys. Must not: put a secret in an error.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';
import { objectStoreConfigOf, objectStoreEnvShape, type ObjectStoreConfig } from '@centcom/storage';

/** CT-API-AUDIT's cap on one export (card B082). */
export const MAX_EXPORT_ROWS = 1_000_000;
/** The longest a download URL may live (B082 guardrail: at most 900 s). */
export const MAX_URL_TTL_S = 900;

/** The environment keys of the audit API. */
export const auditApiEnvSchema = z.object({
  AUDIT_EXPORT_MAX_ROWS: envInt({ min: 1, max: MAX_EXPORT_ROWS })
    .default(MAX_EXPORT_ROWS)
    .meta({ description: 'Most audit events one export holds; a larger result fails.' }),
  AUDIT_EXPORT_URL_TTL_S: envInt({ min: 1, max: MAX_URL_TTL_S })
    .default(MAX_URL_TTL_S)
    .meta({ description: 'Lifetime of an export download URL, in seconds (at most 900).' }),
  AUDIT_EXPORT_RETAIN_H: envInt({ min: 1, max: 168 })
    .default(24)
    .meta({ description: 'Hours an export file is kept after it is written.' }),
  ...objectStoreEnvShape,
});

/** Where exports are stored (the shared object store settings). */
export type { ObjectStoreConfig };

/** The checked configuration. */
export interface AuditApiConfig {
  maxRows: number;
  urlTtlS: number;
  retainMs: number;
  objectStore: ObjectStoreConfig;
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadAuditApiConfig(env?: Env): AuditApiConfig {
  const v = defineConfig(auditApiEnvSchema, env);
  return {
    maxRows: v.AUDIT_EXPORT_MAX_ROWS,
    urlTtlS: v.AUDIT_EXPORT_URL_TTL_S,
    retainMs: v.AUDIT_EXPORT_RETAIN_H * 60 * 60 * 1000,
    objectStore: objectStoreConfigOf(v),
  };
}
