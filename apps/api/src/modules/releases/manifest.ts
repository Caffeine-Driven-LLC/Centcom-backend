/**
 * Release manifests (B084, CT-API-RELEASES, `contracts/schemas/release-manifest.schema.json`): the
 * checks a manifest passes before it can be published, and the verification of its signatures.
 *
 * - **Text kept:** a manifest is parsed from its text, and that exact text is what gets stored and
 *   served, so nothing re-serialises it.
 * - **Schema:** the contract's `release-manifest` schema, plus: only the fields it names (so no CI
 *   URL, commit author or host name can ride along into the public manifest), one artifact per
 *   platform, arch and kind, `min_supported` a version no newer than `version`, at most 256 KiB.
 * - **URLs:** artifacts and `notes_url` are HTTPS, without credentials, query or fragment, on a host
 *   name (not an address, `localhost` or an internal suffix), and on RELEASE_ARTIFACT_HOSTS when
 *   set. They are never fetched.
 * - **Signatures:** every artifact's `sig` is an Ed25519 signature (base64url, 64 bytes) over the
 *   32 bytes of its `sha256`, by the configured key its `sig_kid` names, or by any configured key
 *   when it names none. Without configured keys nothing verifies, so nothing unsigned is accepted.
 *
 * Owns: what a valid manifest is. Must not: accept a manifest any artifact of which is not signed
 * by a configured key.
 */
import { createHash, verify } from 'node:crypto';
import { validate } from '@centcom/contracts';
import { validationFailed, type FieldError } from '@centcom/core';
import type { ReleaseChannel } from '@centcom/db';
import { compareSemver, parseSemver, type Semver } from '../flags/version.js';
import type { ReleaseKey } from './config.js';

/** The largest manifest, in bytes. */
export const MANIFEST_MAX_BYTES = 256 * 1024;
/** The channels (CT-API-RELEASES). */
export const CHANNELS: readonly ReleaseChannel[] = Object.freeze(['stable', 'beta', 'nightly']);
export const PLATFORMS = ['linux', 'darwin', 'win32'] as const;
export const ARCHS = ['x64', 'arm64'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Arch = (typeof ARCHS)[number];

/** One artifact (the contract schema's `artifacts[]`). */
export interface ReleaseArtifact {
  platform: Platform;
  arch: Arch;
  kind?: 'binary' | 'npm' | 'archive';
  url: string;
  sha256: string;
  size: number;
  sig: string;
  sig_kid?: string;
}

/** A manifest (the contract schema). */
export interface ReleaseManifest {
  channel: ReleaseChannel;
  version: string;
  released_at: string;
  min_supported: string;
  rollout_pct?: number;
  notes_url?: string;
  contract_version?: string;
  artifacts: ReleaseArtifact[];
}

/** A checked manifest and its exact text. */
export interface ParsedManifest {
  text: string;
  /** Hex SHA-256 of the text's UTF-8 bytes. */
  sha256: string;
  manifest: ReleaseManifest;
  version: Semver;
  releasedAt: Date;
}

/** The details of refusals (GUIDELINES §3.4). */
export const MANIFEST_DETAILS = Object.freeze({
  invalid: 'The release manifest is not valid.',
  unsigned: 'An artifact is not signed by a configured release key.',
} as const);

const TOP_FIELDS: ReadonlySet<string> = new Set([
  'channel',
  'version',
  'released_at',
  'min_supported',
  'rollout_pct',
  'notes_url',
  'contract_version',
  'artifacts',
]);
const ARTIFACT_FIELDS: ReadonlySet<string> = new Set([
  'platform',
  'arch',
  'kind',
  'url',
  'sha256',
  'size',
  'sig',
  'sig_kid',
]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const INTERNAL_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.corp',
  '.lan',
  '.home.arpa',
];

/** Why `raw` is not a public HTTPS URL on an allowed host, or null when it is. */
function urlProblem(raw: string, hosts: ReadonlySet<string> | null): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:') return 'must be an https:// URL';
  if (url.username !== '' || url.password !== '') return 'must not carry credentials';
  if (url.search !== '' || url.hash !== '') return 'must not have a query or a fragment';
  if (url.port !== '' && url.port !== '443') return 'must use the default HTTPS port';
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || IPV4.test(host) || !host.includes('.')) {
    return 'must name a public host, not an address';
  }
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'must name a public host';
  }
  if (hosts !== null && !hosts.has(host)) return 'must be on a configured artifact host';
  return null;
}

/** Fields the schema does not name: they could leak build metadata, so they are refused. */
function unknownFields(record: Record<string, unknown>, known: ReadonlySet<string>, at: string) {
  return Object.keys(record)
    .filter((k) => !known.has(k))
    .map((k) => ({
      pointer: `${at}/${k}`,
      code: 'not_allowed' as const,
      detail: 'is not a manifest field',
    }));
}

/**
 * The manifest in `text`, checked (schema, fields, versions, URLs); a 422 listing every problem.
 * Signatures are checked separately (`verifySignatures`).
 */
export function parseManifest(
  text: string,
  opts: { artifactHosts: ReadonlySet<string> | null },
): ParsedManifest {
  const fail = (issues: FieldError[]): never => {
    throw validationFailed(issues, MANIFEST_DETAILS.invalid);
  };
  if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) {
    fail([
      { pointer: '', code: 'too_long', detail: `must be at most ${MANIFEST_MAX_BYTES} bytes` },
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail([{ pointer: '', code: 'invalid_format', detail: 'must be JSON' }]);
  }
  const checked = validate('release-manifest', value);
  if (!checked.ok) return fail(checked.errors);
  const manifest = value as ReleaseManifest;
  const issues: FieldError[] = unknownFields(value as Record<string, unknown>, TOP_FIELDS, '');
  const version = parseSemver(manifest.version);
  const minSupported = parseSemver(manifest.min_supported);
  if (version === null) {
    issues.push({
      pointer: '/version',
      code: 'invalid_format',
      detail: 'must be a semantic version',
    });
  }
  if (minSupported === null) {
    issues.push({
      pointer: '/min_supported',
      code: 'invalid_format',
      detail: 'must be a semantic version',
    });
  } else if (version !== null && compareSemver(minSupported, version) > 0) {
    issues.push({
      pointer: '/min_supported',
      code: 'out_of_range',
      detail: 'must not be newer than version',
    });
  }
  if (manifest.contract_version !== undefined && parseSemver(manifest.contract_version) === null) {
    issues.push({
      pointer: '/contract_version',
      code: 'invalid_format',
      detail: 'must be a semantic version',
    });
  }
  const releasedAt = new Date(manifest.released_at);
  if (Number.isNaN(releasedAt.getTime())) {
    issues.push({
      pointer: '/released_at',
      code: 'invalid_format',
      detail: 'must be an RFC 3339 date-time',
    });
  }
  if (manifest.notes_url !== undefined) {
    const problem = urlProblem(manifest.notes_url, null);
    if (problem !== null)
      issues.push({ pointer: '/notes_url', code: 'invalid_value', detail: problem });
  }
  const seen = new Set<string>();
  manifest.artifacts.forEach((artifact, i) => {
    const at = `/artifacts/${i}`;
    issues.push(
      ...unknownFields(artifact as unknown as Record<string, unknown>, ARTIFACT_FIELDS, at),
    );
    const problem = urlProblem(artifact.url, opts.artifactHosts);
    if (problem !== null)
      issues.push({ pointer: `${at}/url`, code: 'invalid_value', detail: problem });
    const slot = `${artifact.platform}/${artifact.arch}/${artifact.kind ?? 'binary'}`;
    if (seen.has(slot)) {
      issues.push({
        pointer: `${at}/platform`,
        code: 'not_allowed',
        detail: `${slot} is listed twice`,
      });
    }
    seen.add(slot);
  });
  if (issues.length > 0) fail(issues);
  return {
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    manifest,
    version: version as Semver,
    releasedAt,
  };
}

/** True when `sig` (base64url) is `key`'s Ed25519 signature over the digest `sha256` (hex). */
function signedBy(key: ReleaseKey, sha256: string, sig: string): boolean {
  const signature = Buffer.from(sig, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== sig) return false;
  try {
    return verify(null, Buffer.from(sha256, 'hex'), key.key, signature);
  } catch {
    return false;
  }
}

/** Checks every artifact's signature against `keys`; a 422 naming each artifact that fails. */
export function verifySignatures(manifest: ReleaseManifest, keys: readonly ReleaseKey[]): void {
  const issues: FieldError[] = [];
  manifest.artifacts.forEach((artifact, i) => {
    const at = `/artifacts/${i}`;
    if (artifact.sig_kid !== undefined) {
      const key = keys.find((k) => k.kid === artifact.sig_kid);
      if (key === undefined) {
        issues.push({
          pointer: `${at}/sig_kid`,
          code: 'invalid_value',
          detail: 'names no configured release key',
        });
        return;
      }
      if (!signedBy(key, artifact.sha256, artifact.sig)) {
        issues.push({ pointer: `${at}/sig`, code: 'invalid_value', detail: 'does not verify' });
      }
      return;
    }
    if (!keys.some((key) => signedBy(key, artifact.sha256, artifact.sig))) {
      issues.push({
        pointer: `${at}/sig`,
        code: 'invalid_value',
        detail: 'is not signed by a configured release key',
      });
    }
  });
  if (issues.length > 0) throw validationFailed(issues, MANIFEST_DETAILS.unsigned);
}

/** Newest first: by version for stable and beta, by `released_at` for nightly. */
export function releaseOrder(
  channel: ReleaseChannel,
): (a: { version: Semver; releasedAt: Date }, b: { version: Semver; releasedAt: Date }) => number {
  const byTime = (a: { releasedAt: Date }, b: { releasedAt: Date }) =>
    b.releasedAt.getTime() - a.releasedAt.getTime();
  const byVersion = (a: { version: Semver }, b: { version: Semver }) =>
    compareSemver(b.version, a.version);
  return channel === 'nightly'
    ? (a, b) => byTime(a, b) || byVersion(a, b)
    : (a, b) => byVersion(a, b) || byTime(a, b);
}
