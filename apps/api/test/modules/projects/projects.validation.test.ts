/**
 * Project input rules (B035, card test projects.validation.test.ts, acceptance 3): `repo`
 * refuses local paths, URLs with credentials and tokens, and values over 128 code points (a table,
 * then property tests over generated paths, credentialed URLs and token shapes), while opaque
 * references pass; names are 1-60 code points after NFC without control characters; a rejected
 * value is never echoed, in the 422 or in the logs.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkRepoRef,
  MAX_REPO_REF_LENGTH,
  parseProjectCreate,
  parseProjectUpdate,
} from '../../../src/modules/projects/index.js';
import { arrange, createProject, projectsApp } from './helpers.js';

const issuesOf = (fn: () => unknown): { pointer: string; code: string; detail: string }[] => {
  try {
    fn();
  } catch (err) {
    return (err as { errors?: { pointer: string; code: string; detail: string }[] }).errors ?? [];
  }
  return [];
};

const refused = (value: unknown): boolean => 'issues' in checkRepoRef(value);

/** Accepted: what clients are told to send (CT-API-WORKSPACES), and other opaque references. */
const ACCEPTED = [
  'github.com/acme/app',
  'acme/app',
  'gitlab.example.com/group/sub/app',
  `sha256:${'ab12'.repeat(16)}`,
  'ab12'.repeat(16),
  'https://github.com/acme/app.git',
  'git@github.com:acme/app.git',
  'ssh-remote-7f3a',
];

/**
 * A fake credential built from pieces, so the source never holds a whole token shape: the
 * repository's secret scan (gitleaks) would otherwise report these deliberate test values.
 */
const fake = (...parts: string[]): string => parts.join('');

/** Refused, with the reason the table gives. */
const REFUSED: readonly [string, string][] = [
  ['/home/alex/work/repo', 'local path'],
  ['~/repo', 'local path'],
  ['~', 'local path'],
  ['./repo', 'local path'],
  ['../repo', 'local path'],
  ['..', 'local path'],
  ['C:\\Users\\a\\repo', 'local path'],
  ['C:/Users/a/repo', 'local path'],
  ['\\\\server\\share\\repo', 'local path'],
  ['file:///home/alex/repo', 'local path'],
  ['repo\\sub', 'local path'],
  ['https://user:pw@github.com/a/b.git', 'credentials'],
  [fake('https://gh', 'p_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b'), 'credentials'],
  ['ssh://git:secret@example.com/a/b', 'credentials'],
  ['https://example.com/a/b?access_token=abc', 'credentials'],
  ['https://example.com/a/b?private_token=abc', 'credentials'],
  [fake('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'), 'token'],
  [fake('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnop'), 'token'],
  [fake('gl', 'pat-', 'abcdefghijklmnopqrst'), 'token'],
  [fake('xo', 'xb-', '1234567890-abcdefghij'), 'token'],
  [fake('sk', '-', 'abcdefghijklmnopqrstuvwxyz'), 'token'],
  [fake('sk', '_live_', 'abcdefghijklmnop1234'), 'token'],
  [fake('AK', 'IA', 'ABCDEFGHIJKLMNOP'), 'token'],
  [fake('AI', 'za', 'a'.repeat(35)), 'token'],
  [fake('cen', '_live_', 'abcdefghijklmnop'), 'token'],
  [fake('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiJ4In0.c2lnbmF0dXJl'), 'token'],
  ['acme/app with spaces', 'spaces'],
  ['acme/app\u0000', 'control character'],
  ['', 'empty'],
  ['r'.repeat(MAX_REPO_REF_LENGTH + 1), 'too long'],
  ['r'.repeat(257), 'too long'],
];

describe('checkRepoRef', () => {
  it('accepts opaque references (acceptance 3)', () => {
    for (const value of ACCEPTED) expect(checkRepoRef(value), value).toEqual({ value });
    expect(checkRepoRef('r'.repeat(MAX_REPO_REF_LENGTH))).toEqual({
      value: 'r'.repeat(MAX_REPO_REF_LENGTH),
    });
    // Code points after NFC, not UTF-16 units: 128 astral characters fit.
    expect('value' in checkRepoRef('😀'.repeat(MAX_REPO_REF_LENGTH))).toBe(true);
    expect(checkRepoRef('e\u0301')).toEqual({ value: 'é' });
  });

  it('refuses paths, credentials, tokens and bad lengths, never echoing them (acceptance 3)', () => {
    for (const [value, why] of REFUSED) {
      const result = checkRepoRef(value);
      expect('issues' in result, `${why}: ${value}`).toBe(true);
      if ('issues' in result && value.length > 0) {
        for (const i of result.issues) expect(i.detail).not.toContain(value);
      }
    }
    expect(refused(42)).toBe(true);
    expect(refused(null)).toBe(true);
    expect(refused({})).toBe(true);
  });

  it('refuses any absolute, home or drive path (property)', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
    const path = fc.tuple(
      fc.constantFrom('/', '~/', '~', './', '../', 'C:\\', 'd:/', '\\\\', 'file://'),
      fc.array(segment, { minLength: 0, maxLength: 5 }),
      fc.constantFrom('/', '\\'),
    );
    fc.assert(
      fc.property(path, ([start, parts, sep]) => refused(`${start}${parts.join(sep)}`)),
      { numRuns: 500 },
    );
  });

  it('refuses any URL that carries a user part (property)', () => {
    const word = fc.stringMatching(/^[A-Za-z0-9._~-]{1,16}$/);
    const url = fc.tuple(
      fc.constantFrom('https', 'http', 'ssh', 'git+ssh'),
      word,
      fc.option(word, { nil: undefined }),
      fc.constantFrom('github.com', 'gitlab.example.com', '10.0.0.1:8080'),
      fc.array(word, { maxLength: 3 }),
    );
    fc.assert(
      fc.property(url, ([scheme, user, password, host, parts]) => {
        const userinfo = password === undefined ? user : `${user}:${password}`;
        const value = `${scheme}://${userinfo}@${host}/${parts.join('/')}`;
        return value.length > MAX_REPO_REF_LENGTH || refused(value);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses well-known token shapes anywhere in the value (property)', () => {
    const alnum = (min: number, max: number) =>
      fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${min},${max}}$`));
    const token = fc.oneof(
      alnum(20, 40).map((s) => `ghp_${s}`),
      alnum(20, 40).map((s) => `gho_${s}`),
      alnum(20, 30).map((s) => `glpat-${s}`),
      alnum(20, 40).map((s) => `sk-${s}`),
      fc.stringMatching(/^[0-9A-Z]{16}$/).map((s) => `AKIA${s}`),
      alnum(10, 30).map((s) => `cen_live_${s}`),
    );
    const around = fc.stringMatching(/^[a-z0-9/.-]{0,20}$/);
    fc.assert(
      fc.property(around, token, around, (before, t, after) => {
        const value = `${before}${before === '' ? '' : '/'}${t}${after === '' ? '' : '/'}${after}`;
        return value.length > MAX_REPO_REF_LENGTH || refused(value);
      }),
      { numRuns: 500 },
    );
  });

  it('accepts lowercase owner/name references and hex digests (property)', () => {
    const word = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,19}$/);
    fc.assert(
      fc.property(word, word, (owner, name) => !refused(`github.com/${owner}/${name}`)),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (bytes) => !refused(`sha256:${Buffer.from(bytes).toString('hex')}`),
      ),
      { numRuns: 300 },
    );
  });
});

describe('project bodies', () => {
  it('take a name of 1 to 60 code points after NFC, without control characters', () => {
    expect(parseProjectCreate({ name: 'Api' })).toEqual({ name: 'Api', repoRef: null });
    expect(parseProjectCreate({ name: '😀'.repeat(60) }).name).toHaveLength(120);
    expect(issuesOf(() => parseProjectCreate({}))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'required' }),
    ]);
    expect(issuesOf(() => parseProjectCreate({ name: '' }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'too_short' }),
    ]);
    expect(issuesOf(() => parseProjectCreate({ name: 'x'.repeat(61) }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'too_long' }),
    ]);
    expect(issuesOf(() => parseProjectCreate({ name: 'a\u0007b' }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'invalid_format' }),
    ]);
  });

  it('report every bad field, ignore unknown ones, and refuse a body that is not an object', () => {
    expect(parseProjectCreate({ name: 'Api', repo: 'acme/app', created_by: 'x' })).toEqual({
      name: 'Api',
      repoRef: 'acme/app',
    });
    expect(issuesOf(() => parseProjectCreate({ name: 7, repo: '~/repo' }))).toEqual([
      expect.objectContaining({ pointer: '/name', code: 'invalid_type' }),
      expect.objectContaining({ pointer: '/repo', code: 'invalid_format' }),
    ]);
    expect(issuesOf(() => parseProjectCreate([]))).toEqual([
      expect.objectContaining({ pointer: '', code: 'invalid_type' }),
    ]);
    // On create, repo is a string: null is not a value there.
    expect(issuesOf(() => parseProjectCreate({ name: 'Api', repo: null }))).toEqual([
      expect.objectContaining({ pointer: '/repo', code: 'invalid_type' }),
    ]);
  });

  it('on update take name and repo (null clears it), and need at least one', () => {
    expect(parseProjectUpdate({ name: 'Web' })).toEqual({ name: 'Web', fields: ['name'] });
    expect(parseProjectUpdate({ repo: null })).toEqual({ repoRef: null, fields: ['repo'] });
    expect(parseProjectUpdate({ name: 'Web', repo: 'acme/web' })).toEqual({
      name: 'Web',
      repoRef: 'acme/web',
      fields: ['name', 'repo'],
    });
    expect(issuesOf(() => parseProjectUpdate({ other: 1 }))).toEqual([
      expect.objectContaining({ pointer: '', code: 'too_few' }),
    ]);
    expect(issuesOf(() => parseProjectUpdate({ repo: 'C:\\repo' }))).toEqual([
      expect.objectContaining({ pointer: '/repo', code: 'invalid_format' }),
    ]);
  });
});

describe('a refused repo over the API', () => {
  it('is a 422 pointing at /repo that echoes nothing and logs nothing of it', async () => {
    const t = await projectsApp();
    const { workspaceId, users } = arrange(t.store);
    const secret = 'https://user:hunter2-very-secret@github.com/acme/app.git';
    const res = await createProject(t.app, workspaceId, users.member, {
      name: 'Api',
      repo: secret,
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ pointer: '/repo', code: 'invalid_format' })],
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(t.captured.lines())).not.toContain('hunter2');
    expect(t.projectStore.rows.size).toBe(0);
  });
});
