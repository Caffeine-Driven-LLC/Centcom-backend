/**
 * Runs the real relay for a load test (B095): a JWKS server for the test tickets, the relay
 * process on a loopback port (several of them for the cross-node profile), a resource sampler that
 * reads /proc, and kill/restart for the reconnect storm.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testJwks } from '@centcom/testkit/sim';
import type { Backing } from './backing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLOCK_TICKS = 100; // sysconf(_SC_CLK_TCK) on Linux

/** The JWKS the relay verifies tickets against. */
export async function startJwks(set?: {
  keys: unknown[];
}): Promise<{ url: string; server: Server }> {
  const body = JSON.stringify(set ?? testJwks());
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, server };
}

export interface RelayOptions {
  port: number;
  jwksUrl: string;
  backing: Backing;
  region?: string;
  /** Extra environment, such as RELAY_MAX_CONNECTIONS. */
  env?: Record<string, string>;
  /** Raise the open-file limit of the relay (default 200 000, within the hard limit). */
  nofile?: number;
}

export class RelayProcess {
  private child: ChildProcess | undefined;
  private lastCpuTicks = 0;
  private lastSample = 0;

  constructor(readonly opts: RelayOptions) {}

  get url(): string {
    return `ws://127.0.0.1:${this.opts.port}/v1/ws`;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Starts the relay and resolves when `/readyz` answers 200. */
  async start(): Promise<void> {
    const { backing } = this.opts;
    const env: Record<string, string> = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'development',
      SERVICE_NAME: 'relay',
      LOG_LEVEL: 'warn',
      HOST: '127.0.0.1',
      PUBLIC_API_URL: 'http://localhost:3000',
      RELAY_PORT: String(this.opts.port),
      RELAY_REGION: this.opts.region ?? 'local',
      DATABASE_URL: backing.databaseUrl,
      REDIS_URL: backing.redisUrl,
      RELAY_JWKS_URL: this.opts.jwksUrl,
      OBJECT_STORE_ENDPOINT: backing.objectStore.endpoint,
      OBJECT_STORE_REGION: 'us-east-1',
      OBJECT_STORE_BUCKET: backing.objectStore.bucket,
      OBJECT_STORE_ACCESS_KEY_ID: backing.objectStore.accessKey,
      OBJECT_STORE_SECRET_ACCESS_KEY: backing.objectStore.secretKey,
      OTEL_ENABLED: 'false',
      RELAY_MAX_CONNECTIONS: '100000',
      TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.test.json'),
      ...this.opts.env,
    };
    const limit = this.opts.nofile ?? 200_000;
    // `sh -c 'ulimit -n N; exec node ...'`: the relay needs one descriptor per connection.
    this.child = spawn(
      'sh',
      [
        '-c',
        `ulimit -n ${limit} 2>/dev/null || ulimit -n $(ulimit -Hn); exec "$0" "$@"`,
        process.execPath,
        '--import',
        'tsx',
        join(ROOT, 'apps/relay/src/main.ts'),
      ],
      { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    this.child.once('exit', () => (this.lastCpuTicks = 0));
    await this.ready();
    this.lastCpuTicks = 0;
    this.lastSample = 0;
  }

  async ready(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.opts.port}/readyz`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new Error(`the relay exited with ${this.child.exitCode} while starting`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('the relay did not become ready');
  }

  /** SIGKILL: a crash (the reconnect storm). */
  crash(): void {
    this.child?.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  /** Relay CPU (cores used since the last call) and resident memory in MiB, from /proc. */
  sample(): { cpuCores: number; rssMiB: number } | undefined {
    // `sh -c exec node`: the child pid is the node process.
    const pid = this.child?.pid;
    if (pid === undefined) return undefined;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
      const now = performance.now();
      const cpuCores =
        this.lastSample === 0
          ? 0
          : (ticks - this.lastCpuTicks) / CLOCK_TICKS / ((now - this.lastSample) / 1000);
      this.lastCpuTicks = ticks;
      this.lastSample = now;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      return { cpuCores, rssMiB: rssKb / 1024 };
    } catch {
      return undefined;
    }
  }
}
