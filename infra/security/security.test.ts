/**
 * The security scripts (B097) against fixture repositories with deliberately bad content, and
 * against this repository: install scripts, range versions, licences and advisories
 * (`security:deps`), planted credentials (`security:secrets`), the SBOMs, the allow-list rules and
 * the parity of the gitleaks configuration with the local scanner.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAllowList } from './allowlist.mjs';
import { checkDeps, findInstallScripts, type AuditRunner } from './check-deps.mjs';
import { checkLicenses } from './check-licenses.mjs';
import { RULES, readExceptions, scanSecrets } from './scan-secrets.mjs';
import { SERVICES, writeSboms } from './sbom.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const CEN = `cen_live_${'Ab3k9ZqR7x'.repeat(4).slice(0, 32)}`;
const clean: AuditRunner = () => ({ failed: false, unreachable: false, output: '' });

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'security-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
/** A fixture repository: package.json files, installed packages and extra files. */
function fixture(o: {
  manifest?: Record<string, unknown>;
  installed?: Record<string, Record<string, unknown>>;
  files?: Record<string, string>;
}): string {
  const root = join(tmp, `repo${(counter += 1)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(o.manifest ?? { name: 'fx', dependencies: {} }),
  );
  for (const [name, pkg] of Object.entries(o.installed ?? {})) {
    const dir = join(root, 'node_modules', '.pnpm', `${name}@1.0.0`, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }));
  }
  for (const [path, text] of Object.entries(o.files ?? {})) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FUTURE = '2999-01-01';
const entry = (over: Record<string, unknown> = {}) => ({
  package: 'native-thing',
  reason: 'prebuilt binary lookup only',
  issue: 'docs/security/hardening.md#install-scripts',
  expires: FUTURE,
  ...over,
});

describe('security:deps on fixtures', () => {
  const licenses = { MIT: [{ name: 'ok', versions: ['1.0.0'], license: 'MIT' }] };
  const run = (root: string, extra: Partial<Parameters<typeof checkDeps>[0]> = {}) =>
    checkDeps({ root, audit: clean, licenseReport: licenses, ...extra });

  it('passes a clean repository', () => {
    expect(run(fixture({})).problems).toEqual([]);
  });

  it('fails for a dependency with an install script that is not on the allow-list', () => {
    const root = fixture({
      installed: { 'native-thing': { scripts: { postinstall: 'node build.js' } } },
    });
    const { problems } = run(root);
    expect(problems).toEqual([
      'install script: native-thing@1.0.0 declares postinstall and is not on install-script-allowlist.json',
    ]);
  });

  it('also catches a preinstall script and a binding.gyp, and passes them once allow-listed with a reason', () => {
    const root = fixture({
      installed: { 'native-thing': { scripts: { preinstall: 'x' } }, gyp: {} },
      files: { 'node_modules/.pnpm/gyp@1.0.0/node_modules/gyp/binding.gyp': '{}' },
    });
    expect(findInstallScripts(root).map((s) => `${s.name}:${s.script}`)).toEqual([
      'gyp:binding.gyp',
      'native-thing:preinstall',
    ]);
    mkdirSync(join(root, 'infra/security'), { recursive: true });
    writeFileSync(
      join(root, 'infra/security/install-script-allowlist.json'),
      JSON.stringify({ entries: [entry(), entry({ package: 'gyp' })] }),
    );
    expect(run(root).problems).toEqual([]);
  });

  it('fails for a range version', () => {
    const root = fixture({
      manifest: { name: 'fx', dependencies: { left: '^1.2.3', right: '~2.0.0', ok: '1.0.0' } },
    });
    const { problems } = run(root);
    expect(problems.join('\n')).toContain('dependencies.left = ^1.2.3');
    expect(problems.join('\n')).toContain('dependencies.right = ~2.0.0');
    expect(problems.join('\n')).not.toContain('dependencies.ok');
  });

  it('fails for a GPL dependency, a missing licence and an unreviewed UNLICENSED one', () => {
    const report = {
      'GPL-3.0': [{ name: 'copyleft', versions: ['2.0.0'], license: 'GPL-3.0' }],
      Unknown: [{ name: 'mystery', versions: ['1.0.0'], license: 'Unknown' }],
    };
    const { problems } = run(fixture({}), { licenseReport: report });
    expect(problems.join('\n')).toContain('licence: copyleft@2.0.0 (GPL-3.0)');
    expect(problems.join('\n')).toContain(
      'licence: mystery@1.0.0 (Unknown) (no licence metadata; review it)',
    );
  });

  it('fails for a high-severity advisory, with the audit output', () => {
    const audit: AuditRunner = () => ({
      failed: true,
      unreachable: false,
      output: 'high: Prototype pollution in x',
    });
    const { problems } = run(fixture({}), { audit });
    expect(problems[0]).toContain('pnpm audit found high or critical vulnerabilities');
    expect(problems[0]).toContain('Prototype pollution in x');
  });

  it('retries an unreachable advisory service once, then fails closed on main and warns on pull requests', () => {
    let calls = 0;
    const down: AuditRunner = () => {
      calls += 1;
      return { failed: true, unreachable: true, output: 'ENOTFOUND registry' };
    };
    const closed = run(fixture({}), { audit: down, mode: 'closed' });
    expect(calls).toBe(2);
    expect(closed.problems).toEqual([
      'advisory: the audit service could not be reached (failing closed; use --mode warn on pull requests)',
    ]);
    const warn = run(fixture({}), { audit: down, mode: 'warn' });
    expect(warn.problems).toEqual([]);
    expect(warn.warnings).toEqual(['advisory: the audit service could not be reached']);
    let flaky = 0;
    const recovers: AuditRunner = () =>
      flaky++ === 0
        ? { failed: true, unreachable: true, output: 'ETIMEDOUT' }
        : { failed: false, unreachable: false, output: '' };
    expect(run(fixture({}), { audit: recovers }).problems).toEqual([]);
  });
});

describe('allow-lists', () => {
  const write = (name: string, entries: unknown[]) => {
    const file = join(tmp, name);
    writeFileSync(file, JSON.stringify({ entries }));
    return file;
  };
  it('need a reason, an issue link and a future expiry', () => {
    expect(readAllowList(write('ok.json', [entry()]))).toHaveLength(1);
    expect(() => readAllowList(write('a.json', [entry({ reason: '' })]))).toThrow(/reason/);
    expect(() => readAllowList(write('b.json', [entry({ issue: undefined })]))).toThrow(/issue/);
    expect(() => readAllowList(write('c.json', [entry({ expires: '2020-01-01' })]))).toThrow(
      /expired/,
    );
    expect(() => readAllowList(write('d.json', [entry({ expires: 'later' })]))).toThrow(
      /YYYY-MM-DD/,
    );
    expect(() => readAllowList(join(tmp, 'missing.json'))).toThrow(/cannot be read/);
  });

  it("the repository's own lists are valid and every entry is dated in the future", () => {
    for (const file of ['install-script-allowlist.json', 'license-allowlist.json']) {
      expect(() => readAllowList(join(REPO, 'infra/security', file))).not.toThrow();
    }
    expect(
      readExceptions(join(REPO, 'infra/security/secrets-allowlist.json')).length,
    ).toBeGreaterThan(0);
  });

  it('a licence exception works for exactly the named package', () => {
    const root = fixture({
      files: {
        'infra/security/license-allowlist.json': JSON.stringify({
          entries: [entry({ package: 'copyleft' })],
        }),
      },
    });
    const report = {
      'GPL-3.0': [
        { name: 'copyleft', versions: ['2.0.0'], license: 'GPL-3.0' },
        { name: 'other', versions: ['1.0.0'], license: 'GPL-3.0' },
      ],
    };
    expect(checkLicenses({ root, report })).toEqual(['licence: other@1.0.0 (GPL-3.0)']);
  });
});

describe('security:secrets', () => {
  it('fails on a planted AWS key and a planted cen_live_ key, printing places and no text', () => {
    const root = fixture({
      files: { 'test/fixture.ts': `const a = '${AWS}';\nconst b = '${CEN}';\n` },
    });
    expect(scanSecrets({ root })).toEqual([
      { path: 'test/fixture.ts', line: 1, rule: 'aws-access-key' },
      { path: 'test/fixture.ts', line: 2, rule: 'centcom-api-key' },
    ]);
    const cli = spawnSync('node', [join(REPO, 'infra/security/scan-secrets.mjs'), '--root', root], {
      encoding: 'utf8',
    });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toBe(
      'test/fixture.ts:1 aws-access-key\ntest/fixture.ts:2 centcom-api-key\n',
    );
    expect(cli.stdout + cli.stderr).not.toMatch(/AKIA|cen_live_Ab3k/);
  });

  it('passes a clean tree, skips node_modules and binary files, and ignores short look-alikes', () => {
    const root = fixture({
      files: { 'a.md': 'cen_live_Ab3kExample and AKIAshort\n', 'node_modules/x/y.js': AWS },
    });
    writeFileSync(join(root, 'blob.bin'), Buffer.concat([Buffer.from([0, 0]), Buffer.from(AWS)]));
    expect(scanSecrets({ root })).toEqual([]);
    expect(
      spawnSync('node', [join(REPO, 'infra/security/scan-secrets.mjs'), '--root', root]).status,
    ).toBe(0);
  });

  it('detects the other rules too', () => {
    const lines = [
      '-----BEGIN ' + 'RSA PRIVATE KEY-----',
      'ghp_' + 'a'.repeat(36),
      'xoxb-' + '1234567890-abcdef',
      'sk_live_' + 'a'.repeat(24),
      'whsec_' + 'b'.repeat(32),
    ];
    const root = fixture({ files: { 'x.txt': lines.join('\n') } });
    expect(scanSecrets({ root }).map((f) => f.rule)).toEqual([
      'private-key',
      'github-token',
      'slack-token',
      'stripe-key',
      'stripe-webhook-secret',
    ]);
  });

  it('honours a scoped exception, but not an expired or reason-less one', () => {
    const files = { 'docs/x.md': AWS, 'src/x.ts': AWS };
    const ex = (over: Record<string, unknown>) =>
      JSON.stringify({
        entries: [
          {
            rule: 'aws-access-key',
            path: 'docs/',
            reason: 'quoted example',
            expires: FUTURE,
            ...over,
          },
        ],
      });
    const ok = fixture({ files: { ...files, 'infra/security/secrets-allowlist.json': ex({}) } });
    expect(scanSecrets({ root: ok })).toEqual([
      { path: 'src/x.ts', line: 1, rule: 'aws-access-key' },
    ]);
    for (const bad of [{ expires: '2020-01-01' }, { reason: '' }, { rule: 'nope' }]) {
      const root = fixture({
        files: { ...files, 'infra/security/secrets-allowlist.json': ex(bad) },
      });
      expect(() => scanSecrets({ root })).toThrow();
    }
    const cli = spawnSync(
      'node',
      [
        join(REPO, 'infra/security/scan-secrets.mjs'),
        '--root',
        fixture({ files: { 'infra/security/secrets-allowlist.json': ex({ reason: '' }) } }),
      ],
      { encoding: 'utf8' },
    );
    expect(cli.status).toBe(2);
  });

  it('--staged scans only what is staged in a git checkout', () => {
    const root = fixture({ files: { 'clean.txt': 'hello\n' } });
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        encoding: 'utf8',
      });
    git('init', '-q');
    git('add', 'clean.txt', 'package.json');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(root, 'leak.txt'), `${AWS}\n`);
    expect(scanSecrets({ root, staged: true })).toEqual([]);
    git('add', 'leak.txt');
    expect(scanSecrets({ root, staged: true })).toEqual([
      { path: 'leak.txt', line: 1, rule: 'aws-access-key' },
    ]);
  });

  it('is clean on this repository', () => {
    expect(scanSecrets({ root: REPO })).toEqual([]);
  });
});

describe('gitleaks configuration', () => {
  const toml = readFileSync(join(REPO, '.gitleaks.toml'), 'utf8');

  it("extends the default rules and carries the local scanner's custom rules", () => {
    expect(toml).toMatch(/\[extend\]\s+useDefault = true/);
    expect(toml).toContain('id = "centcom-api-key"');
    expect(toml).toContain('id = "centcom-stripe-webhook-secret"');
    // AWS, GitHub, Slack, Stripe keys and PEM blocks are default gitleaks rules
    expect(RULES.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'aws-access-key',
        'centcom-api-key',
        'private-key',
        'github-token',
        'slack-token',
        'stripe-key',
        'stripe-webhook-secret',
      ]),
    );
  });

  it('dates every allowlist, and no date has passed', () => {
    const dates = [...toml.matchAll(/description = "expires: (\d{4}-\d{2}-\d{2})\./g)].map(
      (m) => m[1] ?? '',
    );
    const allowlists =
      toml.match(/\[\[rules\.allowlists\]\]|^\[\[allowlists\]\]|^\[allowlist\]/gm) ?? [];
    expect(dates).toHaveLength(allowlists.length);
    for (const d of dates)
      expect(new Date(`${d}T23:59:59Z`).getTime(), d).toBeGreaterThan(Date.now());
  });
});

describe('security:sbom', () => {
  it('writes a CycloneDX SBOM with components for each service', () => {
    const out = join(tmp, 'sbom');
    const files = writeSboms({ root: REPO, out });
    expect(files.map((f) => f.split('/').pop())).toEqual(SERVICES.map((s) => `${s}.cdx.json`));
    for (const f of files) {
      const bom = JSON.parse(readFileSync(f, 'utf8')) as {
        bomFormat: string;
        components: { name: string }[];
      };
      expect(bom.bomFormat).toBe('CycloneDX');
      expect(bom.components.length).toBeGreaterThan(20);
    }
  }, 60_000);
});

describe('security:deps on this repository', () => {
  it('passes on the real lockfile (advisory check stubbed; the CI job runs the real one)', () => {
    expect(checkDeps({ root: REPO, audit: clean }).problems).toEqual([]);
  }, 60_000);
});
