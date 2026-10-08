/**
 * The relay process (B037 main.ts, acceptance 8 and the failure modes): run as a child process
 * against Redis and Postgres that accept connections but never answer, it starts anyway (liveness
 * 200, readiness 503), logs its `version` and the `contract_version` of contracts/index.json,
 * and exits 0 on SIGTERM. A port in use exits 1 with a clear log line; a SIGTERM during startup
 * exits 0 without serving; a bad configuration exits 1 naming the key.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const RELAY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../tsconfig.test.json', import.meta.url));
const CONTRACT_VERSION = (
  JSON.parse(readFileSync(new URL('../../../contracts/index.json', import.meta.url), 'utf8')) as {
    contract_version: string;
  }
).contract_version;
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** A TCP server that accepts connections and never says a word. */
async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function freePort(): Promise<number> {
  const { port, close } = await silentServer();
  await close();
  return port;
}

let redis: Awaited<ReturnType<typeof silentServer>>;
let pg: Awaited<ReturnType<typeof silentServer>>;
beforeAll(async () => {
  redis = await silentServer();
  pg = await silentServer();
});
afterAll(async () => {
  await redis.close();
  await pg.close();
});

interface Run {
  child: ChildProcess;
  lines: Record<string, unknown>[];
  stderr: () => string;
  line(msg: string, ms?: number): Promise<Record<string, unknown>>;
  exit: Promise<number | null>;
}

function run(env: Record<string, string>): Run {
  const child = spawn(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, MAIN], {
    cwd: RELAY_ROOT,
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'relay',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PUBLIC_API_URL: 'http://localhost:3000',
      REDIS_URL: `redis://127.0.0.1:${redis.port}`,
      DATABASE_URL: `postgres://relay:relay@127.0.0.1:${pg.port}/relay`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: Record<string, unknown>[] = [];
  let buffered = '';
  let errors = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += String(chunk);
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    for (const part of parts.filter(Boolean)) {
      try {
        lines.push(JSON.parse(part) as Record<string, unknown>);
      } catch {
        // not a log line
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => (errors += String(chunk)));
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const line = async (msg: string, ms = 30_000): Promise<Record<string, unknown>> => {
    const end = Date.now() + ms;
    for (;;) {
      const found = lines.find((l) => l['msg'] === msg);
      if (found !== undefined) return found;
      if (Date.now() > end || child.exitCode !== null) {
        throw new Error(
          `no ${msg} line; got ${lines.map((l) => String(l['msg'])).join(', ')} ${errors}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { child, lines, stderr: () => errors, line, exit };
}

describe('the relay process', () => {
  it('starts with its dependencies down, logs its versions, and exits 0 on SIGTERM', async () => {
    const port = await freePort();
    const relay = run({ RELAY_PORT: String(port) });
    try {
      const started = await relay.line('relay.started');
      expect(started).toMatchObject({
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        port,
        ready: false,
      });
      const live = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(live.status).toBe(200);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ checks: { redis: { ok: false } } });
      relay.child.kill('SIGTERM');
      expect(await relay.exit).toBe(0);
      expect(relay.lines.map((l) => l['msg'])).toEqual(
        expect.arrayContaining(['relay.signal', 'shutdown.started', 'shutdown.complete']),
      );
      expect(JSON.stringify(relay.lines)).not.toContain('relay:relay@');
    } finally {
      relay.child.kill('SIGKILL');
    }
  }, 60_000);

  it('exits 1 with relay.port_in_use when the port is taken', async () => {
    const taken = await silentServer();
    const relay = run({ RELAY_PORT: String(taken.port) });
    try {
      expect(await relay.exit).toBe(1);
      expect(relay.lines.find((l) => l['msg'] === 'relay.port_in_use')).toMatchObject({
        port: taken.port,
      });
    } finally {
      relay.child.kill('SIGKILL');
      await taken.close();
    }
  }, 60_000);

  it('exits 0 without serving when SIGTERM comes during startup', async () => {
    const port = await freePort();
    const relay = run({ RELAY_PORT: String(port) });
    try {
      await relay.line('relay.starting');
      relay.child.kill('SIGTERM');
      expect(await relay.exit).toBe(0);
      const messages = relay.lines.map((l) => l['msg']);
      expect(messages).toContain('relay.start_aborted');
      expect(messages).not.toContain('relay.started');
    } finally {
      relay.child.kill('SIGKILL');
    }
  }, 60_000);

  it('exits 1 naming a bad key, without its value', async () => {
    const relay = run({ RELAY_PORT: 'not-a-port', REDIS_URL: 'redis://user:hunter2@127.0.0.1:1' });
    try {
      expect(await relay.exit).toBe(1);
      expect(relay.stderr()).toContain('RELAY_PORT');
      expect(relay.stderr()).not.toContain('hunter2');
    } finally {
      relay.child.kill('SIGKILL');
    }
  }, 60_000);
});
