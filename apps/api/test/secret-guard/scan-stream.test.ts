/**
 * The backup scanner (B101 surface 5), `dist/scan-stream.js`: it copies standard input to standard output
 * unchanged, exits 0 for a clean stream and 3 for one that holds a provider credential, also when the
 * credential is split across the scanner's windows, and never prints the matched text. (Needs the built
 * output of `tsc -b`; skipped without it.) The backup and restore scripts' use of it is tested in
 * infra/dr/scan.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'dist', 'scan-stream.js');
const ANTHROPIC = ['sk', 'ant', 'api03', 'Zq8WmN3xK7vB2cT5yH9jL4pR6'].join('-');

const scan = (input: Buffer, name = 'db/test.dump') =>
  spawnSync('node', [SCRIPT, name], {
    input,
    maxBuffer: 1 << 28,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  });

describe.skipIf(!existsSync(SCRIPT))('scan-stream.js', () => {
  it('copies a clean stream through byte for byte and exits 0', () => {
    const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251));
    const r = scan(data);
    expect(r.status).toBe(0);
    expect(Buffer.compare(r.stdout, data)).toBe(0);
    expect(r.stderr.toString()).toContain('clean');
  });

  it('exits 3 on a credential, still copies the data, and never prints the text', () => {
    const data = Buffer.from(`COPY users FROM stdin;\n1\tada\t${ANTHROPIC}\n\\.\n`);
    const r = scan(data);
    expect(r.status).toBe(3);
    expect(Buffer.compare(r.stdout, data)).toBe(0);
    const err = r.stderr.toString();
    expect(err).toContain('quarantined');
    expect(err).not.toContain(ANTHROPIC);
  });

  it('finds a credential that straddles the 64 KiB window boundary', () => {
    const window = 64 * 1024;
    const data = Buffer.concat([
      Buffer.alloc(window - 10, ' '),
      Buffer.from(ANTHROPIC),
      Buffer.alloc(window, ' '),
    ]);
    expect(scan(data).status).toBe(3);
  });

  it('refuses a missing or odd artefact name with exit 2', () => {
    expect(spawnSync('node', [SCRIPT], { input: '' }).status).toBe(2);
    expect(scan(Buffer.alloc(1), 'x; rm -rf /').status).toBe(2);
  });
});
