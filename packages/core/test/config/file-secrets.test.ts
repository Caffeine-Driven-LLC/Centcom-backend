/** KEY_FILE secrets: precedence, trimming, unreadable files, limits and permission warnings. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defineConfig,
  MAX_SECRET_FILE_BYTES,
  secretString,
  z,
  type ConfigWarning,
  type SecretFiles,
} from '../../src/index.js';

const schema = z.object({ FOO: secretString(), MODE: z.string().default('x') });
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function secretFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  temps.push(dir);
  const path = join(dir, 'foo.secret');
  writeFileSync(path, content);
  return path;
}

function issuesOf(fn: () => unknown): ConfigError['issues'] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error('expected a ConfigError');
}

describe('KEY_FILE', () => {
  it('reads the value from the file', () => {
    expect(defineConfig(schema, { FOO_FILE: secretFile('from-file') }).FOO.reveal()).toBe(
      'from-file',
    );
  });

  it('wins over KEY when both are set', () => {
    expect(
      defineConfig(schema, { FOO: 'from-env', FOO_FILE: secretFile('from-file') }).FOO.reveal(),
    ).toBe('from-file');
  });

  it.each([
    ['a trailing newline', 'value\n'],
    ['a trailing CRLF', 'value\r\n'],
    ['several trailing newlines', 'value\n\n'],
  ])('trims %s', (_, content) => {
    expect(defineConfig(schema, { FOO_FILE: secretFile(content) }).FOO.reveal()).toBe('value');
  });

  it('keeps inner whitespace and trims the path', () => {
    const path = secretFile('two words\n');
    expect(defineConfig(schema, { FOO_FILE: `  ${path}  ` }).FOO.reveal()).toBe('two words');
  });

  it('a blank KEY_FILE falls back to KEY', () => {
    expect(defineConfig(schema, { FOO: 'from-env', FOO_FILE: '  ' }).FOO.reveal()).toBe('from-env');
  });

  it('an unreadable file is a ConfigError naming KEY_FILE, without the path', () => {
    const missing = join(tmpdir(), 'centcom-no-such-dir', 'secret-file-name');
    const issues = issuesOf(() => defineConfig(schema, { FOO_FILE: missing }));
    expect(issues).toEqual([{ key: 'FOO_FILE', problem: 'file cannot be read (ENOENT)' }]);
    expect(JSON.stringify(issues)).not.toContain('secret-file-name');
  });

  it('a directory is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-dir-'));
    temps.push(dir);
    mkdirSync(join(dir, 'inner'));
    expect(issuesOf(() => defineConfig(schema, { FOO_FILE: join(dir, 'inner') }))).toEqual([
      { key: 'FOO_FILE', problem: 'must point to a regular file' },
    ]);
  });

  it(`a file over ${MAX_SECRET_FILE_BYTES} bytes is refused`, () => {
    expect(
      issuesOf(() =>
        defineConfig(schema, { FOO_FILE: secretFile('x'.repeat(MAX_SECRET_FILE_BYTES + 1)) }),
      ),
    ).toEqual([{ key: 'FOO_FILE', problem: `file is larger than ${MAX_SECRET_FILE_BYTES} bytes` }]);
  });

  it('an empty file counts as unset', () => {
    expect(issuesOf(() => defineConfig(schema, { FOO_FILE: secretFile('\n') }))).toEqual([
      { key: 'FOO', problem: 'is required' },
    ]);
  });

  it('reports file problems alongside schema problems', () => {
    const strict = z.object({
      FOO: secretString(),
      PORT: z.string().regex(/^\d+$/, 'must be digits'),
    });
    expect(
      issuesOf(() =>
        defineConfig(strict, { FOO_FILE: join(tmpdir(), 'centcom-missing'), PORT: 'abc' }),
      ),
    ).toEqual([
      { key: 'FOO_FILE', problem: 'file cannot be read (ENOENT)' },
      { key: 'PORT', problem: 'must be digits' },
    ]);
  });
});

describe('secret file permissions', () => {
  const fakeFiles = (mode: number): SecretFiles => ({
    stat: () => ({ mode, size: 6, isFile: () => true }),
    read: () => 'secret',
  });
  const load = (env: Record<string, string>, mode: number, platform: string) => {
    const warnings: ConfigWarning[] = [];
    defineConfig(
      schema,
      { FOO_FILE: '/run/secrets/foo', ...env },
      { files: fakeFiles(mode), platform, onWarning: (w) => warnings.push(w) },
    );
    return warnings;
  };

  it('warns (key name only) when a production secret file is world-readable', () => {
    expect(load({ NODE_ENV: 'production' }, 0o100644, 'linux')).toEqual([
      {
        key: 'FOO_FILE',
        problem: 'secret file is readable by every user; restrict it to the service user',
      },
    ]);
  });

  it('stays quiet for 0600 files, outside production, and on Windows', () => {
    expect(load({ NODE_ENV: 'production' }, 0o100600, 'linux')).toEqual([]);
    expect(load({ NODE_ENV: 'development' }, 0o100644, 'linux')).toEqual([]);
    expect(load({ NODE_ENV: 'production' }, 0o100644, 'win32')).toEqual([]);
  });

  it('defaults to process.emitWarning', async () => {
    const emitted: string[] = [];
    const listener = (w: Error) => emitted.push(w.message);
    process.on('warning', listener);
    try {
      defineConfig(
        schema,
        { NODE_ENV: 'production', FOO_FILE: '/run/secrets/foo' },
        { files: fakeFiles(0o100644), platform: 'linux' },
      );
      await new Promise((resolve) => setImmediate(resolve)); // warnings are delivered on a later tick
    } finally {
      process.off('warning', listener);
    }
    expect(emitted).toEqual([
      'FOO_FILE: secret file is readable by every user; restrict it to the service user',
    ]);
  });
});
