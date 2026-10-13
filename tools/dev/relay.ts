/**
 * `pnpm dev:relay` (B103): runs the relay against the `pnpm dev:up` stack, next to `pnpm dev:api`.
 * Reads `.env.local` (written by dev:up) and adds what the relay needs on a laptop:
 *
 * - `RELAY_JWKS_URL`, the API's signing keys at `PUBLIC_API_URL`, which verify relay tickets;
 * - `RELAY_PORT` 8088 (where `pnpm dev:api` tells clients to connect: ws://localhost:8088/v1/ws).
 *
 * Values already in the environment or in `.env.local` win over these defaults.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const envFile = resolve(root, '.env.local');
if (!existsSync(envFile)) {
  process.stderr.write('dev:relay: .env.local is missing. Run `pnpm dev:up` first.\n');
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

const api = process.env['PUBLIC_API_URL'] ?? 'http://localhost:3000';
set('RELAY_JWKS_URL', `${api.replace(/\/+$/, '')}/.well-known/jwks.json`);
set('RELAY_PORT', '8088');
// Session history and snapshots live in the dev stack's MinIO (buckets made by `pnpm dev:up`); the
// relay writes the durable log there and the API reads it back.
const minio = `http://127.0.0.1:${process.env['CENTCOM_DEV_MINIO_PORT'] ?? '9000'}`;
set('OBJECT_STORE_ENDPOINT', minio);
set('OBJECT_STORE_REGION', 'us-east-1');
set('OBJECT_STORE_BUCKET', 'history');
set('OBJECT_STORE_ACCESS_KEY_ID', 'centcom');
set('OBJECT_STORE_SECRET_ACCESS_KEY', 'dev-only');

// Run the relay in a child so Ctrl-C and SIGTERM reach it and its exit code is ours.
const child = spawn(
  process.execPath,
  ['--import', 'tsx', resolve(root, 'apps/relay/src/main.ts')],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.test.json') },
  },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
