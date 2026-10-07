/** docs/config.md and .env.example match the schemas (B004 acceptance 6). */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeKeys, main, renderConfigDocs, SECTIONS } from '../../scripts/gen-config-docs.js';
import { baseEnvSchema } from '../../src/index.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generated config docs', () => {
  it('docs/config.md and .env.example are identical to a fresh render', () => {
    for (const [path, content] of renderConfigDocs()) {
      expect(
        readFileSync(join(REPO_ROOT, path), 'utf8'),
        `${path} is stale: run pnpm --filter @centcom/core gen:config-docs`,
      ).toBe(content);
    }
  });

  it('documents every base key with its type, default, required and secret flags', () => {
    const keys = describeKeys(baseEnvSchema);
    expect(keys.map((k) => k.key)).toEqual(Object.keys(baseEnvSchema.shape));
    expect(keys.find((k) => k.key === 'PORT')).toMatchObject({
      type: 'integer 1..65535',
      defaultValue: '3000',
      required: false,
      secret: false,
    });
    expect(keys.find((k) => k.key === 'DATABASE_URL')).toMatchObject({
      defaultValue: null,
      required: true,
      secret: true,
    });
    expect(keys.find((k) => k.key === 'NODE_ENV')).toMatchObject({
      type: '`development` | `test` | `production`',
      required: true,
    });
    for (const k of keys) expect(k.description, k.key).not.toBe('');
    expect(SECTIONS.map((s) => s.schema)).toContain(baseEnvSchema);
  });

  it('.env.example holds names and placeholders only, one line per key', () => {
    const example = renderConfigDocs().get('.env.example') ?? '';
    const lines = example.split('\n').filter((l) => l && !l.startsWith('#'));
    // Every section's keys, in order: the base keys, then each lane's (B023: RATELIMIT_*).
    expect(lines.map((l) => l.split('=')[0])).toEqual(
      SECTIONS.flatMap((s) => Object.keys(s.schema.shape)),
    );
    expect(
      lines.slice(0, Object.keys(baseEnvSchema.shape).length).map((l) => l.split('=')[0]),
    ).toEqual(Object.keys(baseEnvSchema.shape));
    expect(example).not.toMatch(/sslmode=require|rediss:\/\//); // no production-looking values
  });

  it('the CLI rewrites the files and --check fails when they are stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-docs-'));
    temps.push(root);
    expect(main(['--check'], root)).toBe(1); // nothing written yet
    expect(main([], root)).toBe(0);
    expect(main(['--check'], root)).toBe(0);
    expect(readFileSync(join(root, 'docs', 'config.md'), 'utf8')).toBe(
      renderConfigDocs().get('docs/config.md'),
    );
  });
});
