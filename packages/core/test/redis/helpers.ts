/**
 * Test helpers for the Redis backends (B009): one harness per implementation, so the contract
 * suites run the same cases against the in-memory backend (always) and a real Redis 7 (when
 * REDIS_URL is set: CI's integration job). Both run on a fake clock for the rate-limit window;
 * key TTLs are real time on Redis, so `wait` advances the clock and, for Redis, also sleeps.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import {
  createLogger,
  createMemoryRedis,
  createRedis,
  defineConfig,
  keyPrefixFor,
  Secret,
  z,
  type Logger,
  type MetricLabels,
  type Metrics,
  type RedisBackend,
} from '../../src/index.js';

/** The Redis to test against, or undefined to run the in-memory backend only. */
export const REDIS_URL: string | undefined = defineConfig(
  z.object({ REDIS_URL: z.string().optional() }),
).REDIS_URL;

/** A clock tests move by hand. */
export class FakeClock {
  now = Date.UTC(2026, 9, 7, 12, 0, 0);
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** A logger whose lines are kept. */
export function captureLogger(): {
  logger: Logger;
  raw: () => string;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const logger = createLogger({
    level: 'trace',
    service: 'redis-test',
    version: 'test',
    destination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
  });
  const raw = (): string => chunks.join('');
  return {
    logger,
    raw,
    lines: () =>
      raw()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** A Metrics that counts counters by name. */
export function countingMetrics(): {
  metrics: Metrics;
  count: (name: string, labels?: MetricLabels) => number;
} {
  const counts = new Map<string, number>();
  return {
    metrics: {
      counter: (name) => ({ inc: (n = 1) => counts.set(name, (counts.get(name) ?? 0) + n) }),
      histogram: () => ({ observe: () => undefined }),
    },
    count: (name) => counts.get(name) ?? 0,
  };
}

/** One backend under test. */
export interface Harness {
  backend: RedisBackend;
  clock: FakeClock;
  /** Lets `ms` pass for TTLs: the fake clock, and real time on Redis. */
  wait(ms: number): Promise<void>;
  /** The namespace the backend writes under. */
  prefix: string;
  /** A raw client without the prefix (Redis only), to look behind the backend's back. */
  admin?: Redis;
  log: ReturnType<typeof captureLogger>;
  counters: ReturnType<typeof countingMetrics>;
  close(): Promise<void>;
}

/** A unique, valid key prefix per harness, so parallel test files never share keys. */
const uniquePrefix = (): string => keyPrefixFor(`t${randomBytes(5).toString('hex')}`);

export async function memoryHarness(): Promise<Harness> {
  const clock = new FakeClock();
  const log = captureLogger();
  const counters = countingMetrics();
  const backend = createMemoryRedis(clock.read, { logger: log.logger, metrics: counters.metrics });
  return {
    backend,
    clock,
    prefix: '',
    wait: async (ms) => {
      clock.advance(ms);
    },
    log,
    counters,
    close: () => backend.close(),
  };
}

export async function redisHarness(): Promise<Harness> {
  if (REDIS_URL === undefined) throw new Error('redisHarness needs REDIS_URL');
  const clock = new FakeClock();
  const log = captureLogger();
  const counters = countingMetrics();
  const prefix = uniquePrefix();
  const backend = createRedis({
    url: new Secret(REDIS_URL),
    keyPrefix: prefix,
    clock: clock.read,
    logger: log.logger,
    metrics: counters.metrics,
  });
  const admin = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  await backend.ping();
  return {
    backend,
    clock,
    prefix,
    admin,
    wait: async (ms) => {
      clock.advance(ms);
      await sleep(ms);
    },
    log,
    counters,
    close: async () => {
      await backend.close();
      admin.disconnect();
    },
  };
}

/** The harnesses to run: [name, factory, enabled]. */
export const HARNESSES: readonly [string, () => Promise<Harness>, boolean][] = [
  ['in-memory', memoryHarness, true],
  ['Redis 7', redisHarness, REDIS_URL !== undefined],
];

/** Resolves once `check` returns true, polling every 10 ms; rejects after `timeoutMs`. */
export async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(10);
  }
}

/** A localhost port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, 'close');
  return port;
}

/** A server that accepts connections and never answers. */
export async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
