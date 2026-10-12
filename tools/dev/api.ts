/**
 * `pnpm dev:api` (B102): runs the API service against the `pnpm dev:up` stack. Reads `.env.local`
 * (written by dev:up), adds what the service needs on a laptop and starts `src/main.ts`:
 *
 * - a signing key, generated on the first run and appended to `.env.local` (that file is ignored
 *   by git; no key is ever committed), so tokens survive a restart;
 * - e-mail sign-in through Mailpit (http://127.0.0.1:8025), links in the web UI;
 * - the relay address for sessions (ws://localhost:8088/v1/ws, see `pnpm dev:relay`);
 * - the device verification address and the sign-in return address on this server.
 *
 * Values already in the environment or in `.env.local` win over these defaults.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const envFile = resolve(root, '.env.local');
if (!existsSync(envFile)) {
  process.stderr.write('dev:api: .env.local is missing. Run `pnpm dev:up` first.\n');
  process.exit(1);
}

const fromFile = new Map<string, string>();
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (match?.[1] !== undefined && match[2] !== undefined) {
    fromFile.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
}
const set = (key: string, value: string): void => {
  if ((process.env[key] ?? '') !== '') return;
  const fileValue = fromFile.get(key);
  process.env[key] = fileValue !== undefined && fileValue !== '' ? fileValue : value;
};
for (const [key, value] of fromFile) if (value !== '') set(key, value);

if ((process.env['AUTH_SIGNING_KEYS'] ?? '') === '') {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const key = { kty: 'OKP', crv: 'Ed25519', kid: 'dev-1', x: String(jwk.x), d: String(jwk.d) };
  appendFileSync(
    envFile,
    `\n# Added by pnpm dev:api: a local signing key. Never commit this file.\nAUTH_SIGNING_KEYS=${JSON.stringify([key])}\nAUTH_SIGNING_KID=dev-1\n`,
  );
  process.env['AUTH_SIGNING_KEYS'] = JSON.stringify([key]);
  process.env['AUTH_SIGNING_KID'] = 'dev-1';
  process.stdout.write('dev:api: generated a signing key in .env.local\n');
}

const base = process.env['PUBLIC_API_URL'] ?? 'http://localhost:3000';
set('DEV_MAILPIT_URL', 'http://127.0.0.1:8025');
set('MAGIC_LINK_BASE_URL', base);
set('LOGIN_RETURN_TO_ALLOWLIST', `${base}/device`);
set('DEVICE_VERIFICATION_URI', `${base}/device`);
// Sessions: clients are told to connect to the relay `pnpm dev:relay` starts.
set('RELAY_PUBLIC_URL', 'ws://localhost:8088/v1/ws');

// Run the service in a child so Ctrl-C and SIGTERM reach it and its exit code is ours.
const child = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'apps/api/src/main.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.test.json') },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
