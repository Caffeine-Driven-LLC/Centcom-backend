/**
 * The entrypoint as a process (B102): invalid configuration exits non-zero before anything
 * listens and prints no value; with Postgres and Redis (DATABASE_URL, REDIS_URL: CI's integration
 * job) it serves /readyz and exits 0 within the grace period on SIGTERM.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { defineConfig, z } from '@centcom/core';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';
import { testEnv } from './helpers.js';

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.test.json', import.meta.url));
const { REDIS_URL, PATH: PATH_VALUE } = defineConfig(
  z.object({ REDIS_URL: z.string().optional(), PATH: z.string().optional() }),
);

const kids: ChildProcess[] = [];
afterEach(() => {
  for (const kid of kids.splice(0)) kid.kill('SIGKILL');
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN], {
    // tsx maps the workspace packages to their sources through the test tsconfig, as `pnpm dev:api` does.
    env: { PATH: PATH_VALUE ?? '', TSX_TSCONFIG_PATH: TSCONFIG, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += String(d)));
  child.stderr.on('data', (d) => (err += String(d)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => out + err };
}

const reaches = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createServer();
    socket.once('error', () => resolve(true)); // the port is taken: something listens
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(false)));
  });

describe('the API entrypoint as a process (B102)', () => {
  it('exits 1 on invalid configuration, names the keys, prints no value and opens no port', async () => {
    const port = await freePort();
    const secret = 'postgres://user:hunter2-secret@127.0.0.1:1/db';
    const env = testEnv({
      PORT: String(port),
      DATABASE_URL: secret,
      AUTH_SIGNING_KID: 'not allowed kid!',
    });
    const { exited, output } = run(
      Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
    );
    expect(await exited).toBe(1);
    expect(output()).toContain('AUTH_SIGNING_KID');
    expect(output()).not.toContain('hunter2-secret');
    expect(output()).not.toContain('not allowed kid!');
    expect(await reaches(port)).toBe(false);
  }, 60_000);

  it.runIf(ADMIN_URL !== undefined && REDIS_URL !== undefined)(
    'serves /readyz and exits 0 on SIGTERM',
    async () => {
      const database = await migratedDatabase(2);
      try {
        const port = await freePort();
        const env = testEnv({
          PORT: String(port),
          HOST: '127.0.0.1',
          DATABASE_URL: database.url,
          REDIS_URL: REDIS_URL as string,
          DEV_MAILPIT_URL: undefined,
        });
        const { child, exited, output } = run(
          Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
        );
        let ready = false;
        for (let i = 0; i < 100 && !ready; i += 1) {
          try {
            ready = (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        expect(ready, output()).toBe(true);
        const stoppedAt = Date.now();
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
        expect(Date.now() - stoppedAt).toBeLessThan(30_000);
      } finally {
        await database.drop();
      }
    },
    90_000,
  );
});
