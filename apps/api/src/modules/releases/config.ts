/**
 * Release configuration (B084).
 *
 * | Key | Default | |
 * |---|---|---|
 * | `RELEASE_PUBKEYS` | none | Ed25519 public keys that sign artifacts: comma-separated, each `kid:<base64url>` or `<base64url>` (32 bytes). Two at once for rotation. Without any, nothing can be published. |
 * | `RELEASE_KEEP_ACTIVE` | 20 | Manifests kept active per channel (1 to 100); older ones are `superseded`. |
 * | `RELEASE_ARTIFACT_HOSTS` | any | Comma-separated host names artifact URLs may use (the CDN). |
 *
 * Keys live in configuration, never in code. Owns: reading and checking these keys.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** Keys accepted at once, at most. */
export const MAX_RELEASE_KEYS = 4;

/** A release signing key. */
export interface ReleaseKey {
  /** Its id (`sig_kid` in manifests); null when configured without one. */
  kid: string | null;
  key: KeyObject;
}

const KID = /^[A-Za-z0-9_.-]{1,64}$/;
const B64URL = /^[A-Za-z0-9_-]{43}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** One `RELEASE_PUBKEYS` entry as a key, or a message saying what is wrong. */
function parseKey(entry: string): ReleaseKey | string {
  const at = entry.lastIndexOf(':');
  const kid = at === -1 ? null : entry.slice(0, at);
  const x = at === -1 ? entry : entry.slice(at + 1);
  if (kid !== null && !KID.test(kid)) return 'a key id must be 1 to 64 of [A-Za-z0-9_.-]';
  if (!B64URL.test(x) || Buffer.from(x, 'base64url').length !== 32) {
    return 'each key must be 32 bytes of base64url (an Ed25519 public key)';
  }
  try {
    return { kid, key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }) };
  } catch {
    return 'each key must be an Ed25519 public key';
  }
}

/** `RELEASE_PUBKEYS` as keys; an issue for anything malformed. */
export const releaseKeysSchema = z.string().transform((value, ctx) => {
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length > MAX_RELEASE_KEYS) {
    ctx.addIssue({ code: 'custom', message: `at most ${MAX_RELEASE_KEYS} keys` });
    return z.NEVER;
  }
  const keys: ReleaseKey[] = [];
  for (const entry of entries) {
    const parsed = parseKey(entry);
    if (typeof parsed === 'string') {
      ctx.addIssue({ code: 'custom', message: parsed });
      return z.NEVER;
    }
    keys.push(parsed);
  }
  const kids = keys.map((k) => k.kid).filter((k) => k !== null);
  if (new Set(kids).size !== kids.length) {
    ctx.addIssue({ code: 'custom', message: 'a key id is given twice' });
    return z.NEVER;
  }
  return keys;
});

/** The environment keys of releases. */
export const releasesEnvSchema = z.object({
  RELEASE_PUBKEYS: releaseKeysSchema.optional().meta({
    description:
      'Ed25519 public keys (base64url, optionally kid:key) that sign release artifacts, comma-separated; two during a rotation.',
  }),
  RELEASE_KEEP_ACTIVE: envInt({ min: 1, max: 100 })
    .default(20)
    .meta({ description: 'Manifests kept active per channel; older ones are superseded.' }),
  RELEASE_ARTIFACT_HOSTS: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v.split(',').every((h) => HOST.test(h.trim().toLowerCase())),
      'must be comma-separated host names',
    )
    .meta({
      description: 'Host names artifact URLs may use (the CDN); any public host when unset.',
    }),
});

/** The checked configuration. */
export interface ReleasesConfig {
  keys: readonly ReleaseKey[];
  keepActive: number;
  /** Allowed artifact hosts; null: any public host. */
  artifactHosts: ReadonlySet<string> | null;
}

/** Reads the keys from `env` (default the process environment); throws ConfigError. */
export function loadReleasesConfig(env?: Env): ReleasesConfig {
  const v = defineConfig(releasesEnvSchema, env);
  return {
    keys: v.RELEASE_PUBKEYS ?? [],
    keepActive: v.RELEASE_KEEP_ACTIVE,
    artifactHosts:
      v.RELEASE_ARTIFACT_HOSTS === undefined
        ? null
        : new Set(v.RELEASE_ARTIFACT_HOSTS.split(',').map((h) => h.trim().toLowerCase())),
  };
}
