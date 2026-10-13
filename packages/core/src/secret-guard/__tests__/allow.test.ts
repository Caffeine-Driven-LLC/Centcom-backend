/** The allow-list (B101): by pattern id and location only, with a reason and an expiry. */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AllowListError, MAX_ALLOW_ENTRIES, createAllowList, loadAllowListFile } from '../allow.js';
import { secretGuardConfig } from '../config.js';
import { scanText } from '../scan.js';
import { ANTHROPIC_KEY } from '../../../test/secret-guard/helpers.js';

const entry = (over: Record<string, unknown> = {}) => ({
  pattern_id: 'openai_api_key',
  scope: 'path',
  value: 'docs/',
  reason: 'examples',
  expires: '2999-01-01',
  ...over,
});

describe('allow-list', () => {
  it('a path entry hides its pattern in docs/ but not in src/, and not a different pattern', () => {
    const allow = createAllowList({ entries: [entry()] });
    const key = ANTHROPIC_KEY.replace('sk-ant-', 'sk-proj-'); // an openai-shaped key
    expect(scanText(key, { allow, location: { path: 'docs/x.md' } })).toEqual([]);
    expect(scanText(key, { allow, location: { path: 'docs/deep/x.md' } })).toEqual([]);
    expect(scanText(key, { allow, location: { path: 'src/x.ts' } })).toHaveLength(1);
    expect(scanText(key, { allow, location: { path: 'docsx/x.md' } })).toHaveLength(1);
    // an anthropic key matches `anthropic_api_key`, which this entry does not cover
    expect(scanText(ANTHROPIC_KEY, { allow, location: { path: 'docs/x.md' } })).toHaveLength(1);
  });

  it('route and log_component scopes match exactly', () => {
    const allow = createAllowList({
      entries: [
        entry({ scope: 'route', value: '/v1/a' }),
        entry({ scope: 'log_component', value: 'billing' }),
      ],
    });
    expect(allow.allows('openai_api_key', { route: '/v1/a' })).toBe(true);
    expect(allow.allows('openai_api_key', { route: '/v1/a/b' })).toBe(false);
    expect(allow.allows('openai_api_key', { logComponent: 'billing' })).toBe(true);
    expect(allow.allows('openai_api_key', undefined)).toBe(false);
  });

  it('refuses an entry without a reason, past its expiry, with an unknown field, id or scope', () => {
    expect(() => createAllowList({ entries: [entry({ reason: '' })] })).toThrow(AllowListError);
    const noReason: Record<string, unknown> = entry();
    delete noReason['reason'];
    expect(() => createAllowList({ entries: [noReason] })).toThrow(/reason/);
    expect(() => createAllowList({ entries: [entry({ expires: '2020-01-01' })] })).toThrow(
      /expired/,
    );
    expect(() => createAllowList({ entries: [entry({ expires: 'soon' })] })).toThrow(/YYYY-MM-DD/);
    expect(() => createAllowList({ entries: [entry({ expires: '2999-02-31' })] })).toThrow(
      AllowListError,
    );
    expect(() => createAllowList({ entries: [entry({ pattern_id: 'nope' })] })).toThrow(
      /pattern_id/,
    );
    expect(() => createAllowList({ entries: [entry({ scope: 'content' })] })).toThrow(/scope/);
    expect(() => createAllowList({ entries: [entry({ text: ANTHROPIC_KEY })] })).toThrow(
      /unknown field "text"/,
    );
    expect(() => createAllowList({ entries: [entry({ content: 'x' })] })).toThrow(/unknown field/);
    expect(() => createAllowList({})).toThrow(AllowListError);
  });

  it('takes an entry that expires today, and at most 20 entries', () => {
    const today = new Date('2026-10-13T20:00:00Z');
    expect(
      createAllowList({ entries: [entry({ expires: '2026-10-13' })] }, today).entries,
    ).toHaveLength(1);
    expect(() => createAllowList({ entries: [entry({ expires: '2026-10-12' })] }, today)).toThrow(
      /expired/,
    );
    expect(
      createAllowList({ entries: Array.from({ length: MAX_ALLOW_ENTRIES }, () => entry()) })
        .entries,
    ).toHaveLength(20);
    expect(() => createAllowList({ entries: Array.from({ length: 21 }, () => entry()) })).toThrow(
      /most allowed/,
    );
  });

  it('has no way to allow a content string: the module exports no such function', async () => {
    const mod = await import('../index.js');
    expect(
      Object.keys(mod)
        .filter((k) => /allow/i.test(k))
        .sort(),
    ).toEqual([
      'ALLOW_SCOPES',
      'AllowListError',
      'EMPTY_ALLOW_LIST',
      'MAX_ALLOW_ENTRIES',
      'createAllowList',
      'loadAllowListFile',
    ]);
  });
});

describe('configuration', () => {
  it('is on by default, may be off only in tests, and reads the allow-list file', () => {
    expect(secretGuardConfig({ NODE_ENV: 'production' }).enabled).toBe(true);
    expect(() =>
      secretGuardConfig({ NODE_ENV: 'production', SECRET_GUARD_ENABLED: 'false' }),
    ).toThrow(/test/);
    expect(secretGuardConfig({ NODE_ENV: 'test', SECRET_GUARD_ENABLED: 'false' }).enabled).toBe(
      false,
    );
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    try {
      const file = join(dir, 'allow.json');
      writeFileSync(file, JSON.stringify({ entries: [entry()] }));
      expect(
        secretGuardConfig({ NODE_ENV: 'production', SECRET_GUARD_ALLOW_FILE: file }).allow.entries,
      ).toHaveLength(1);
      writeFileSync(file, JSON.stringify({ entries: [entry({ reason: '' })] }));
      expect(() => loadAllowListFile(file)).toThrow(AllowListError);
      expect(() =>
        secretGuardConfig({ NODE_ENV: 'production', SECRET_GUARD_ALLOW_FILE: file }),
      ).toThrow(AllowListError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
