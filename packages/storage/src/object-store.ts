/**
 * The S3-compatible object store's settings (B082; shared with B055's history and B042's relay):
 * R2 in production, MinIO in development.
 *
 * | Key | Default | |
 * |---|---|---|
 * | `OBJECT_STORE_ENDPOINT` | | `https://` (or `http://`) base URL of the S3 API. |
 * | `OBJECT_STORE_REGION` | `us-east-1` | Signing region (`auto` for R2). |
 * | `OBJECT_STORE_BUCKET` | | The bucket (audit exports, session history). |
 * | `OBJECT_STORE_ACCESS_KEY_ID` | | Secret. |
 * | `OBJECT_STORE_SECRET_ACCESS_KEY` | | Secret. |
 *
 * Owns: these keys and their checks. Must not: put a secret in an error.
 */
import { defineConfig, envUrl, secretString, z, type Env, type Secret } from '@centcom/core';

/** S3 bucket names: 3 to 63 lower-case letters, digits, dots and hyphens. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** The object store's environment keys, to spread into a service's schema. */
export const objectStoreEnvShape = {
  OBJECT_STORE_ENDPOINT: envUrl({ protocols: ['https:', 'http:'], plain: true }).meta({
    description: 'Base URL of the S3-compatible object store (R2, MinIO); path-style requests.',
    example: 'http://127.0.0.1:9000',
  }),
  OBJECT_STORE_REGION: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/, 'must be a region name')
    .default('us-east-1')
    .meta({ description: 'Region the requests are signed for (`auto` for R2).' }),
  OBJECT_STORE_BUCKET: z.string().regex(BUCKET, 'must be an S3 bucket name').meta({
    description: 'Bucket of the object store (audit exports, session history).',
    example: 'centcom-exports',
  }),
  OBJECT_STORE_ACCESS_KEY_ID: secretString().meta({
    description: 'Access key id of the object store.',
    example: 'centcom',
  }),
  OBJECT_STORE_SECRET_ACCESS_KEY: secretString().meta({
    description: 'Secret access key of the object store.',
    example: 'dev-only',
  }),
};

/** The object store's environment keys. */
export const objectStoreEnvSchema = z.object(objectStoreEnvShape);

/** Where objects are stored. */
export interface ObjectStoreConfig {
  /** Without a trailing slash. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: Secret<string>;
  secretAccessKey: Secret<string>;
}

/** The config of checked `objectStoreEnvSchema` values. */
export function objectStoreConfigOf(v: z.infer<typeof objectStoreEnvSchema>): ObjectStoreConfig {
  return {
    endpoint: v.OBJECT_STORE_ENDPOINT.replace(/\/+$/, ''),
    region: v.OBJECT_STORE_REGION,
    bucket: v.OBJECT_STORE_BUCKET,
    accessKeyId: v.OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: v.OBJECT_STORE_SECRET_ACCESS_KEY,
  };
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadObjectStoreConfig(env?: Env): ObjectStoreConfig {
  return objectStoreConfigOf(defineConfig(objectStoreEnvSchema, env));
}
