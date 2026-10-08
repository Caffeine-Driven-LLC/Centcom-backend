/**
 * Release pieces without HTTP (B084 test plan "unit" and "signature tests"): ordering (SemVer with
 * prereleases for stable and beta, `released_at` for nightly), platform and arch matching, the
 * manifest checks (schema, fields, URLs, versions), signatures (valid, tampered, wrong key,
 * unknown key id, two keys during a rotation), the configuration, and the CLI's dry run.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError } from '@centcom/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSemver } from '../../src/modules/flags/version.js';
import { channelView } from '../../src/modules/releases/cache.js';
import { PUBLISH_EXIT, runPublishCli } from '../../src/modules/releases/cli.js';
import { loadReleasesConfig } from '../../src/modules/releases/config.js';
import {
  parseManifest,
  releaseOrder,
  verifySignatures,
  type ReleaseManifest,
} from '../../src/modules/releases/manifest.js';
import type { StoredRelease } from '../../src/modules/releases/repository.js';
import { artifact, manifest, releaseKey, releasesConfig, signDigest, T0 } from './helpers.js';

const key = releaseKey('rel1');
const other = releaseKey('rel2');
const OPEN = { artifactHosts: null };

/** The pointers of the 422 `fn` throws. */
function pointers(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (isAppError(err)) return (err.errors ?? []).map((e) => e.pointer);
    throw err;
  }
  throw new Error('expected a 422');
}

const row = (m: ReleaseManifest, yanked = false): StoredRelease => {
  const text = JSON.stringify(m);
  return {
    channel: m.channel,
    version: m.version,
    releasedAt: new Date(m.released_at),
    minSupported: m.min_supported,
    manifest: text,
    manifestSha256: createHash('sha256').update(text).digest('hex'),
    yankedAt: yanked ? new Date(T0) : null,
  };
};

describe('ordering and matching', () => {
  it('orders stable and beta by SemVer (prereleases first), nightly by released_at', () => {
    const versions = [
      '1.0.0',
      '1.2.0-beta.2',
      '1.2.0-beta.11',
      '1.2.0-rc.1',
      '1.2.0',
      '1.10.0',
      '1.9.3',
    ];
    const items = versions.map((v, i) => ({
      v,
      version: parseSemver(v) ?? { major: 0, minor: 0, patch: 0, pre: [] },
      releasedAt: new Date(T0 + i * 1000),
    }));
    expect([...items].sort(releaseOrder('stable')).map((i) => i.v)).toEqual([
      '1.10.0',
      '1.9.3',
      '1.2.0',
      '1.2.0-rc.1',
      '1.2.0-beta.11',
      '1.2.0-beta.2',
      '1.0.0',
    ]);
    expect([...items].sort(releaseOrder('nightly')).map((i) => i.v)).toEqual(
      [...versions].reverse(),
    );
  });

  it('serves each platform and arch the newest release that has it, never a yanked or corrupt one', () => {
    const v1 = manifest(key, { version: '1.0.0' });
    const v2 = manifest(key, {
      version: '1.1.0',
      artifacts: [artifact(key, 'linux', 'x64', '1.1.0')],
    });
    const v3 = manifest(key, {
      version: '1.2.0',
      artifacts: [artifact(key, 'linux', 'x64', '1.2.0')],
    });
    const corrupt = { ...row(manifest(key, { version: '1.3.0' })), manifest: '{"channel":' };
    const { view, corrupt: bad } = channelView('stable', [
      row(v1),
      row(v2),
      row(v3, true),
      corrupt,
    ]);
    expect(bad).toBe(1);
    expect(view.releases.map((r) => r.version)).toEqual(['1.1.0', '1.0.0']);
    const latest = (p: string, a: string) =>
      JSON.parse(view.latest.get(`${p}/${a}`)?.body ?? 'null') as {
        version: string;
        artifacts: { platform: string }[];
      } | null;
    expect(latest('linux', 'x64')?.version).toBe('1.1.0');
    expect(latest('darwin', 'arm64')?.version).toBe('1.0.0');
    expect(latest('darwin', 'arm64')?.artifacts).toEqual([
      v1.artifacts.find((a) => a.platform === 'darwin' && a.arch === 'arm64'),
    ]);
    // The manifest is the newest release's text, exactly as stored.
    expect(view.manifest?.body).toBe(JSON.stringify(v2));
    expect(channelView('beta', [row(v1)]).view).toMatchObject({ releases: [], manifest: null });
  });
});

describe('manifest checks', () => {
  it('accepts the contract fixture shape and keeps the exact text', () => {
    const m = manifest(key);
    const text = `${JSON.stringify(m, null, 2)}\n`;
    const parsed = parseManifest(text, OPEN);
    expect(parsed.text).toBe(text);
    expect(parsed.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(parsed.manifest.version).toBe('1.0.0');
  });

  it('refuses malformed hashes, non-HTTPS or internal URLs, unknown fields and bad versions', () => {
    const base = manifest(key);
    const at = (over: Partial<ReleaseManifest['artifacts'][number]>) =>
      JSON.stringify({ ...base, artifacts: [{ ...base.artifacts[0], ...over }] });
    expect(pointers(() => parseManifest(at({ sha256: 'xyz' }), OPEN))).toEqual([
      '/artifacts/0/sha256',
    ]);
    expect(pointers(() => parseManifest(at({ sha256: `sha256:${'a'.repeat(64)}` }), OPEN))).toEqual(
      ['/artifacts/0/sha256'],
    );
    for (const url of [
      'http://dl.centcom.dev/x',
      'https://user:pass@dl.centcom.dev/x',
      'https://dl.centcom.dev/x?token=1',
      'https://10.0.0.5/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://builds.internal/x',
      'https://dl.centcom.dev:8443/x',
      'ftp://dl.centcom.dev/x',
    ]) {
      expect(
        pointers(() => parseManifest(at({ url }), OPEN)),
        url,
      ).toEqual(['/artifacts/0/url']);
    }
    expect(
      pointers(() =>
        parseManifest(JSON.stringify({ ...base, ci_url: 'https://ci.example/1' }), OPEN),
      ),
    ).toEqual(['/ci_url']);
    expect(pointers(() => parseManifest(at({ commit_author: 'someone' } as never), OPEN))).toEqual([
      '/artifacts/0/commit_author',
    ]);
    expect(
      pointers(() => parseManifest(JSON.stringify({ ...base, min_supported: '2.0.0' }), OPEN)),
    ).toEqual(['/min_supported']);
    expect(
      pointers(() => parseManifest(JSON.stringify({ ...base, version: '1.0' }), OPEN)),
    ).toEqual(['/version']);
    expect(
      pointers(() =>
        parseManifest(
          JSON.stringify({ ...base, artifacts: [base.artifacts[0], base.artifacts[0]] }),
          OPEN,
        ),
      ),
    ).toEqual(['/artifacts/1/platform']);
    expect(pointers(() => parseManifest('not json', OPEN))).toEqual(['']);
    expect(
      pointers(() => parseManifest(JSON.stringify({ ...base, channel: 'canary' }), OPEN)),
    ).toContain('/channel');
    // A host allowlist, when configured.
    expect(
      pointers(() =>
        parseManifest(JSON.stringify(base), { artifactHosts: new Set(['cdn.centcom.dev']) }),
      ),
    ).toHaveLength(6);
    expect(
      parseManifest(JSON.stringify(base), { artifactHosts: new Set(['dl.centcom.dev']) }).manifest
        .version,
    ).toBe('1.0.0');
  });
});

describe('signatures', () => {
  it('verifies valid signatures, with or without a key id, and two keys during a rotation', () => {
    const m = manifest(key);
    verifySignatures(m, releasesConfig([key]).keys);
    const noKid = { ...m, artifacts: m.artifacts.map((a) => ({ ...a, sig_kid: undefined })) };
    verifySignatures(noKid, releasesConfig([other, key]).keys);
    const mixed = { ...m, artifacts: [artifact(key), artifact(other, 'darwin', 'arm64')] };
    verifySignatures(mixed, releasesConfig([key, other]).keys);
  });

  it('refuses tampered digests, wrong keys, unknown key ids and malformed signatures', () => {
    const m = manifest(key);
    const keys = releasesConfig([key]).keys;
    const first = m.artifacts[0] ?? artifact(key);
    const tampered = { ...m, artifacts: [{ ...first, sha256: 'b'.repeat(64) }] };
    expect(pointers(() => verifySignatures(tampered, keys))).toEqual(['/artifacts/0/sig']);
    const wrong = { ...m, artifacts: [{ ...first, sig: signDigest(other, first.sha256) }] };
    expect(pointers(() => verifySignatures(wrong, keys))).toEqual(['/artifacts/0/sig']);
    const unknownKid = { ...m, artifacts: [{ ...first, sig_kid: 'rel9' }] };
    expect(pointers(() => verifySignatures(unknownKid, keys))).toEqual(['/artifacts/0/sig_kid']);
    for (const sig of ['AAAA', '', `${first.sig}x`, first.sig.replace(/^./, '!')]) {
      expect(
        pointers(() => verifySignatures({ ...m, artifacts: [{ ...first, sig }] }, keys)),
        sig,
      ).toEqual(['/artifacts/0/sig']);
    }
    // No configured key verifies nothing.
    expect(
      pointers(() =>
        verifySignatures({ ...m, artifacts: [{ ...first, sig_kid: undefined }] as never }, []),
      ),
    ).toEqual(['/artifacts/0/sig']);
  });
});

describe('configuration', () => {
  it('reads keys with or without ids, the keep count and the host allowlist', () => {
    const bare = key.entry.split(':')[1] ?? '';
    const config = loadReleasesConfig({
      RELEASE_PUBKEYS: `${key.entry}, ${bare}`,
      RELEASE_ARTIFACT_HOSTS: 'dl.centcom.dev,Mirror.Centcom.dev',
    });
    expect(config.keys.map((k) => k.kid)).toEqual(['rel1', null]);
    expect(config.keepActive).toBe(20);
    expect([...(config.artifactHosts ?? [])]).toEqual(['dl.centcom.dev', 'mirror.centcom.dev']);
    expect(loadReleasesConfig({}).keys).toEqual([]);
  });

  it('refuses keys that are not Ed25519, a key id twice, and more than four keys', () => {
    for (const RELEASE_PUBKEYS of [
      'rel1:short',
      `rel1:${'A'.repeat(43)}!`,
      `${key.entry},${key.entry}`,
      [1, 2, 3, 4, 5].map((i) => releaseKey(`k${i}`).entry).join(','),
      'bad id:AAAA',
    ]) {
      expect(() => loadReleasesConfig({ RELEASE_PUBKEYS }), RELEASE_PUBKEYS.slice(0, 20)).toThrow(
        /RELEASE_PUBKEYS/,
      );
    }
    expect(() => loadReleasesConfig({ RELEASE_KEEP_ACTIVE: '0' })).toThrow(/RELEASE_KEEP_ACTIVE/);
  });
});

describe('the CLI without a database', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'release-cli-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(argv: string[], env: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPublishCli(argv, {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      env: { NODE_ENV: 'test', ...env },
    });
    return { code, out: out.join(''), err: err.join('') };
  }

  it('dry-runs a signed manifest, and refuses a tampered one with its pointers', async () => {
    const env = { RELEASE_PUBKEYS: key.entry };
    const good = join(dir, 'good.json');
    await writeFile(good, JSON.stringify(manifest(key)));
    const ok = await run([good, '--channel', 'stable', '--dry-run'], env);
    expect(ok.code).toBe(PUBLISH_EXIT.ok);
    expect(JSON.parse(ok.out)).toMatchObject({
      ok: true,
      channel: 'stable',
      version: '1.0.0',
      dryRun: true,
    });

    const m = manifest(key);
    const bad = join(dir, 'bad.json');
    await writeFile(
      bad,
      JSON.stringify({ ...m, artifacts: [{ ...m.artifacts[0], sha256: 'c'.repeat(64) }] }),
    );
    const refused = await run([bad, '--channel', 'stable', '--dry-run'], env);
    expect(refused.code).toBe(PUBLISH_EXIT.failed);
    expect(JSON.parse(refused.out)).toMatchObject({
      ok: false,
      code: 'validation_failed',
      errors: [{ pointer: '/artifacts/0/sig' }],
    });

    const otherChannel = await run([good, '--channel', 'beta', '--dry-run'], env);
    expect(otherChannel.code).toBe(PUBLISH_EXIT.failed);
    // Without keys nothing verifies.
    expect((await run([good, '--channel', 'stable', '--dry-run'], {})).code).toBe(
      PUBLISH_EXIT.failed,
    );
  });

  it('answers usage errors with 2, and needs a database to publish for real', async () => {
    for (const argv of [
      [],
      ['m.json'],
      ['m.json', '--channel', 'canary'],
      ['m.json', '--channel', 'stable', '--force'],
    ]) {
      const res = await run(argv, {});
      expect(res.code, argv.join(' ')).toBe(PUBLISH_EXIT.usage);
      expect(res.err).toMatch(/^usage: pnpm release:publish/);
    }
    const good = join(dir, 'good2.json');
    await writeFile(good, JSON.stringify(manifest(key)));
    const res = await run([good, '--channel', 'stable'], { RELEASE_PUBKEYS: key.entry });
    expect(res.code).toBe(PUBLISH_EXIT.usage);
    expect(res.err).toMatch(/DATABASE_URL is required/);
  });
});
