#!/usr/bin/env node
/**
 * Writes infra/deploy/production.env from production.env.example (B091): every `GENERATE:<kind>`
 * value becomes a fresh random secret, every other line is copied as is. It refuses to overwrite
 * an existing file, creates the new one with mode 0600 and never prints a secret.
 *
 *   node infra/deploy/gen-env.mjs [--out <path>]
 *
 * Exit codes: 0 written; 1 the output exists or the template has an unknown GENERATE kind.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outIndex = process.argv.indexOf('--out');
const out = resolve(
  outIndex > 0 ? (process.argv[outIndex + 1] ?? '') : resolve(here, 'production.env'),
);

const kid = `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
/** @type {Record<string, () => string>} */
const generators = {
  hex: () => randomBytes(24).toString('hex'),
  'access-key': () => `centcom${randomBytes(6).toString('hex')}`,
  'base64-32': () => randomBytes(32).toString('base64'),
  'cursor-keys': () => `c1:${randomBytes(32).toString('base64url')}`,
  kid: () => kid,
  'ed25519-jwk-set': () => {
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    return `'${JSON.stringify([{ kty: 'OKP', crv: 'Ed25519', kid, x: jwk.x, d: jwk.d }])}'`;
  },
};

if (existsSync(out)) {
  process.stderr.write(`gen-env: ${out} exists; move it away first (it holds live secrets).\n`);
  process.exit(1);
}
const lines = readFileSync(resolve(here, 'production.env.example'), 'utf8').split('\n');
/** @type {string[]} */
const todo = [];
const text = lines
  .map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=GENERATE:([a-z0-9-]+)/.exec(line);
    if (m === null) {
      if (/^[A-Z][A-Z0-9_]*=CHANGE_ME/.test(line)) todo.push(line.split('=')[0] ?? '');
      return line;
    }
    const make = generators[m[2] ?? ''];
    if (make === undefined) {
      process.stderr.write(`gen-env: unknown GENERATE kind "${m[2]}" for ${m[1]}\n`);
      process.exit(1);
    }
    return `${m[1]}=${make()}`;
  })
  .join('\n');
writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
process.stdout.write(
  `gen-env: wrote ${out} (mode 600).\nStill yours to fill in: ${todo.join(', ')}\n`,
);
