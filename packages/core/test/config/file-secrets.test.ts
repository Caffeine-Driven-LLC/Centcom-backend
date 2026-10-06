/** KEY_FILE secrets: precedence, trimming, unreadable files, limits and permission warnings. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defineConfig,
  MAX_SECRET_FILE_BYTES,
  readSecretFileSync,
  secretString,
  z,
  type ConfigWarning,
  type SecretFileReader,
} from '../../src/index.js';

const schema = z.object({ FOO: secretString(), MODE: z.string().default('x') });
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  temps.push(dir);
  return dir;
}

function secretFile(content: string): string {
  const path = join(tempDir(), 'foo.secret');
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

const fromFile = (content: string): string =>
  defineConfig(schema, { FOO_FILE: secretFile(content) }).FOO.reveal();

describe('KEY_FILE', () => {
  it('reads the value from the file', () => {
    expect(fromFile('from-file')).toBe('from-file');
  });

  it('wins over KEY when both are set', () => {
    expect(
      defineConfig(schema, { FOO: 'from-env', FOO_FILE: secretFile('from-file') }).FOO.reveal(),
    ).toBe('from-file');
  });

  it.each([
    ['a trailing newline', 'value\n'],
    ['a trailing CRLF', 'value\r\n'],
    ['several trailing newlines', 'value\n\r\n\n'],
    ['a UTF-8 byte-order mark', '﻿value\n'],
  ])('removes %s', (_, content) => {
    expect(fromFile(content)).toBe('value');
  });

  it('keeps other whitespace, exactly as for a KEY given directly', () => {
    expect(fromFile(' two words \n')).toBe(' two words ');
    expect(fromFile('value\t\n')).toBe('value\t');
  });

  it('trims in linear time, even around a long run of newlines', () => {
    const started = performance.now();
    expect(fromFile(`a${'\n'.repeat(60_000)}b`)).toBe(`a${'\n'.repeat(60_000)}b`);
    expect(fromFile(`a${'\n'.repeat(60_000)}`)).toBe('a');
    expect(performance.now() - started).toBeLessThan(1_000); // the quadratic regex took ~2.4 s
  });

  it('trims the path itself', () => {
    const path = secretFile('value');
    expect(defineConfig(schema, { FOO_FILE: `  ${path}  ` }).FOO.reveal()).toBe('value');
  });

  it('a blank KEY_FILE falls back to KEY', () => {
    expect(defineConfig(schema, { FOO: 'from-env', FOO_FILE: '  ' }).FOO.reveal()).toBe('from-env');
  });

  it('an empty file counts as unset (it does not fall back to KEY)', () => {
    expect(
      issuesOf(() => defineConfig(schema, { FOO: 'from-env', FOO_FILE: secretFile('\n') })),
    ).toEqual([{ key: 'FOO', problem: 'is required' }]);
  });

  it('an unreadable file is a ConfigError naming KEY_FILE, without the path', () => {
    const missing = join(tmpdir(), 'centcom-no-such-dir', 'secret-file-name');
    const issues = issuesOf(() => defineConfig(schema, { FOO_FILE: missing }));
    expect(issues).toEqual([{ key: 'FOO_FILE', problem: 'file cannot be read (ENOENT)' }]);
    expect(JSON.stringify(issues)).not.toContain('secret-file-name');
  });

  it('a directory is refused', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'inner'));
    expect(issuesOf(() => defineConfig(schema, { FOO_FILE: join(dir, 'inner') }))).toEqual([
      { key: 'FOO_FILE', problem: 'must point to a regular file' },
    ]);
  });

  it(`accepts exactly ${MAX_SECRET_FILE_BYTES} bytes and refuses one more`, () => {
    expect(fromFile('x'.repeat(MAX_SECRET_FILE_BYTES))).toHaveLength(MAX_SECRET_FILE_BYTES);
    expect(issuesOf(() => fromFile('x'.repeat(MAX_SECRET_FILE_BYTES + 1)))).toEqual([
      { key: 'FOO_FILE', problem: `file is larger than ${MAX_SECRET_FILE_BYTES} bytes` },
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

  // FIFOs and character devices exist only on POSIX; CI (Linux) runs these.
  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO and /dev/zero without hanging or reading them',
    () => {
      const fifo = join(tempDir(), 'pipe');
      execFileSync('mkfifo', [fifo]);
      for (const path of [fifo, '/dev/zero']) {
        expect(issuesOf(() => defineConfig(schema, { FOO_FILE: path }))).toEqual([
          { key: 'FOO_FILE', problem: 'must point to a regular file' },
        ]);
      }
    },
  );
});

describe('readSecretFileSync', () => {
  it('returns the permission bits and the content of a regular file', () => {
    const file = readSecretFileSync(secretFile('abc'), 10);
    expect(file.content).toBe('abc');
    expect(file.mode & 0o170000).toBe(0o100000); // S_IFREG
  });

  it('stops reading after maxBytes + 1, whatever the file reports as its size', () => {
    expect(() => readSecretFileSync(secretFile('x'.repeat(11)), 10)).toThrow(
      expect.objectContaining({ code: 'EFBIG' }),
    );
  });
});

describe('reader errors', () => {
  const failing =
    (error: unknown): SecretFileReader =>
    () => {
      throw error;
    };
  it.each([
    [Object.assign(new Error('x'), { code: 'ENOTREG' }), 'must point to a regular file'],
    [Object.assign(new Error('x'), { code: 'EISDIR' }), 'must point to a regular file'],
    [
      Object.assign(new Error('x'), { code: 'EFBIG' }),
      `file is larger than ${MAX_SECRET_FILE_BYTES} bytes`,
    ],
    [Object.assign(new Error('x'), { code: 'EACCES' }), 'file cannot be read (EACCES)'],
    ['not an error object', 'file cannot be read (error)'],
  ])('maps %o to "%s"', (error, problem) => {
    expect(
      issuesOf(() =>
        defineConfig(schema, { FOO_FILE: '/run/secrets/foo' }, { readSecretFile: failing(error) }),
      ),
    ).toEqual([{ key: 'FOO_FILE', problem }]);
  });
});

describe('secret file permissions', () => {
  const reader =
    (mode: number): SecretFileReader =>
    () => ({ mode, content: 'secret' });
  const load = (env: Record<string, string>, mode: number, platform: string) => {
    const warnings: ConfigWarning[] = [];
    defineConfig(
      schema,
      { FOO_FILE: '/run/secrets/foo', ...env },
      { readSecretFile: reader(mode), platform, onWarning: (w) => warnings.push(w) },
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

  it('stays quiet for 0600 and group-readable 0640 files, outside production, and on Windows', () => {
    expect(load({ NODE_ENV: 'production' }, 0o100600, 'linux')).toEqual([]);
    expect(load({ NODE_ENV: 'production' }, 0o100640, 'linux')).toEqual([]);
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
        { readSecretFile: reader(0o100644), platform: 'linux' },
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
