/**
 * The architecture guard (B050; tests "privacy.architecture.test.ts", acceptance 4, guardrail "no
 * code path able to decrypt"): the relay's source imports no decrypting library, calls no
 * decrypting primitive and names no key-material environment variable; a file that imports
 * `libsodium-wrappers` or calls `crypto_box_seal_open` (statically, dynamically or by `require`)
 * is reported, and the script exits non-zero on it.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { scanSource, scanTree } from '../../scripts/privacy-guard.js';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../../..');
const SCRIPT = resolve(import.meta.dirname, '../../scripts/privacy-guard.ts');

describe('the architecture guard (acceptance 4)', () => {
  it('passes on the real tree', () => {
    expect(scanTree(resolve(import.meta.dirname, '../../src'))).toEqual([]);
  });

  it('reports decrypting imports, calls and key-material env names', () => {
    const cases: [string, string][] = [
      ["import sodium from 'libsodium-wrappers';", 'imports libsodium-wrappers'],
      ["import * as s from 'sodium-native';", 'imports sodium-native'],
      ["export { box } from 'tweetnacl';", 'imports tweetnacl'],
      ["const s = await import('libsodium-wrappers-sumo');", 'imports libsodium-wrappers-sumo'],
      ["const nacl = require('tweetnacl');", 'imports tweetnacl'],
      ['sodium.crypto_box_seal_open(c, pk, sk);', 'uses crypto_box_seal_open'],
      [
        'crypto_aead_xchacha20poly1305_ietf_decrypt(null, c, ad, n, k);',
        'uses crypto_aead_xchacha20poly1305_ietf_decrypt',
      ],
      ['s.crypto_secretbox_open_easy(c, n, k);', 'uses crypto_secretbox_open_easy'],
      ["import { createDecipheriv } from 'node:crypto';", 'uses createDecipheriv'],
      ["const k = env['RELAY_SESSION_KEY'];", 'names key material RELAY_SESSION_KEY'],
      ['defineConfig(z.object({ DEVICE_PRIVATE_KEY: z.string() }));', 'names key material'],
    ];
    for (const [source, what] of cases) {
      const findings = scanSource('x.ts', source);
      expect(findings.map((f) => f.what).join(' | '), source).toContain(
        what.split(' ').slice(0, 2).join(' '),
      );
    }
    expect(
      scanSource('ok.ts', "import { createHash } from 'node:crypto'; const k = 'RELAY_JWKS_URL';"),
    ).toEqual([]);
  });

  it('the script exits non-zero on a tree with a decrypting import, zero on the real one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'privacy-guard-'));
    try {
      writeFileSync(
        join(dir, 'bad.ts'),
        "import sodium from 'libsodium-wrappers';\nsodium.crypto_box_seal_open(c, pk, sk);\n",
      );
      const failed = await run('npx', ['tsx', SCRIPT, dir], { cwd: ROOT }).then(
        () => 0,
        (err: { code?: number; stderr?: string }) => {
          expect(err.stderr).toContain('crypto_box_seal_open');
          return err.code ?? -1;
        },
      );
      expect(failed).toBe(1);
      await expect(run('npx', ['tsx', SCRIPT], { cwd: ROOT })).resolves.toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
