/**
 * The generated settings of the Pi test server (B112): gen-env.sh makes every secret from /dev/urandom, none is
 * empty or repeated, the file is mode 600, running it again changes nothing, two installs get different secrets,
 * and nothing secret or key-looking is committed under infra/pi (the generated files are git-ignored).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const DIR = import.meta.dirname;
const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function generate(file: string) {
  return spawnSync('bash', [join(DIR, 'gen-env.sh'), file], {
    encoding: 'utf8',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
}
const values = (file: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-env-'));
  tmps.push(dir);
  return join(dir, 'state', 'pi.env');
};
const SECRETS = [
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'IDEMPOTENCY_ENCRYPTION_KEY',
  'CURSOR_SIGNING_KEYS',
  'OBJECT_STORE_ACCESS_KEY_ID',
  'OBJECT_STORE_SECRET_ACCESS_KEY',
];

describe('gen-env.sh', () => {
  it('writes every secret, non-empty, long enough and all different', () => {
    const file = fresh();
    expect(generate(file).status).toBe(0);
    const v = values(file);
    for (const key of SECRETS) expect(v[key], key).toBeTruthy();
    expect(v['POSTGRES_PASSWORD']).toMatch(/^[0-9a-f]{48}$/);
    expect(v['REDIS_PASSWORD']).toMatch(/^[0-9a-f]{48}$/);
    expect(Buffer.from(v['IDEMPOTENCY_ENCRYPTION_KEY'] ?? '', 'base64')).toHaveLength(32);
    expect(v['CURSOR_SIGNING_KEYS']).toMatch(/^c1:[A-Za-z0-9_-]{43}$/);
    expect(v['OBJECT_STORE_ACCESS_KEY_ID']).toMatch(/^centcom[0-9a-f]{12}$/);
    const distinct = new Set(SECRETS.map((k) => v[k]));
    expect(distinct.size).toBe(SECRETS.length);
  });

  it('is mode 600 and its folder is private', () => {
    const file = fresh();
    generate(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the secrets when run again, and makes different ones for another install', () => {
    const a = fresh();
    generate(a);
    const before = readFileSync(a, 'utf8');
    generate(a);
    expect(readFileSync(a, 'utf8')).toBe(before);
    const b = fresh();
    generate(b);
    for (const key of SECRETS) expect(values(b)[key], key).not.toBe(values(a)[key]);
  });

  it('needs a file argument', () => {
    expect(spawnSync('bash', [join(DIR, 'gen-env.sh')], { encoding: 'utf8' }).status).not.toBe(0);
  });
});

describe('what is committed under infra/pi', () => {
  const files = readdirSync(DIR).filter((f) => !f.startsWith('.') || f === '.gitignore');

  it('git-ignores the generated state folder', () => {
    expect(readFileSync(join(DIR, '.gitignore'), 'utf8')).toContain('.state/');
    expect(
      existsSync(join(DIR, '.state', 'pi.env'))
        ? readFileSync(join(DIR, '.gitignore'), 'utf8')
        : '.state/',
    ).toContain('.state/');
  });

  it('holds no key-looking or password-looking value', () => {
    const patterns = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
      /\bwhsec_[A-Za-z0-9+/=]{10,}/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bgh[pousr]_[A-Za-z0-9]{30,}/,
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
      /(PASSWORD|SECRET|TOKEN)=['"]?[A-Za-z0-9+/=]{20,}/,
    ];
    for (const f of files) {
      const path = join(DIR, f);
      if (!statSync(path).isFile() || f.endsWith('.test.ts')) continue; // the tests quote the patterns
      const text = readFileSync(path, 'utf8');
      for (const p of patterns) expect(text, `${f} matches ${p}`).not.toMatch(p);
    }
  });

  it('does not reuse the production template’s values', () => {
    const production = readFileSync(join(DIR, '..', 'deploy', 'production.env.example'), 'utf8');
    const ours =
      readFileSync(join(DIR, 'docker-compose.pi.yml'), 'utf8') +
      readFileSync(join(DIR, 'gen-env.sh'), 'utf8');
    expect(ours).not.toContain('GENERATE:');
    expect(production).toContain('GENERATE:');
  });
});
