/**
 * Test helpers for the relay skeleton (B037): a logger whose lines are kept, a Metrics that
 * records every series, a readiness probe stub, a relay started on a free port with in-memory
 * dependencies, and a WebSocket client that records what it receives and how it was closed.
 */
import { Writable } from 'node:stream';
import {
  createLogger,
  createMemoryRedis,
  type Logger,
  type MetricLabels,
  type Metrics,
} from '@centcom/core';
import WebSocket from 'ws';
import {
  startRelay,
  SUBPROTOCOL,
  type ReadinessChecks,
  type ReadinessProbe,
  type RelayConfig,
  type RelayDb,
  type RelayModule,
  type RunningRelay,
} from '../src/index.js';

/** A logger at trace level whose lines are kept. */
export function captureLogger(): {
  logger: Logger;
  raw: () => string;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ level: 'trace', service: 'relay', version: 'test', destination });
  const raw = (): string => chunks.join('');
  const lines = (): Record<string, unknown>[] =>
    raw()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, raw, lines };
}

/** A Metrics recording every counter series and its count. */
export function recordingMetrics(): {
  metrics: Metrics;
  count: (name: string, labels?: MetricLabels) => number;
  series: () => { name: string; labels: MetricLabels }[];
} {
  const counts = new Map<string, { name: string; labels: MetricLabels; n: number }>();
  const key = (name: string, labels?: MetricLabels): string =>
    `${name}${JSON.stringify(labels ?? {})}`;
  return {
    metrics: {
      counter: (name, labels) => ({
        inc: (n = 1) => {
          const k = key(name, labels);
          const series = counts.get(k) ?? { name, labels: labels ?? {}, n: 0 };
          series.n += n;
          counts.set(k, series);
        },
      }),
      histogram: () => ({ observe: () => undefined }),
    },
    count: (name, labels) => counts.get(key(name, labels))?.n ?? 0,
    series: () => [...counts.values()].map(({ name, labels }) => ({ name, labels })),
  };
}

/** A probe whose answer the test sets; counts its calls. */
export function stubProbe(
  checks: ReadinessChecks = { redis: { ok: true }, db: { ok: true } },
): ReadinessProbe & {
  checks: ReadinessChecks;
  calls: number;
  hang: boolean;
} {
  const probe = {
    checks,
    calls: 0,
    hang: false,
    check(): Promise<ReadinessChecks> {
      probe.calls++;
      if (probe.hang) return new Promise<ReadinessChecks>(() => undefined);
      return Promise.resolve(probe.checks);
    },
  };
  return probe;
}

/** Relay settings for tests. */
export function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    region: 'test',
    maxConnections: 1000,
    shutdownDrainMs: 25_000,
    maxTransportBytes: 1_048_576,
    allowedOrigins: [],
    ...overrides,
  };
}

/** A started relay with its test doubles. */
export interface TestRelay extends RunningRelay {
  url: string;
  base: string;
  probe: ReturnType<typeof stubProbe>;
  log: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
  stop(): Promise<void>;
}

/** Starts a relay on a free port of 127.0.0.1 with in-memory Redis and no modules. */
export async function testRelay(
  options: {
    config?: Partial<RelayConfig>;
    modules?: RelayModule[];
    probe?: ReturnType<typeof stubProbe>;
  } = {},
): Promise<TestRelay> {
  const log = captureLogger();
  const recorded = recordingMetrics();
  const probe = options.probe ?? stubProbe();
  const running = await startRelay({
    config: testConfig(options.config),
    host: '127.0.0.1',
    logger: log.logger,
    metrics: recorded.metrics,
    redis: createMemoryRedis(),
    db: {} as RelayDb,
    probe,
    modules: options.modules ?? [],
    build: { version: '9.9.9', contract_version: '1.0.0' },
  });
  if (running === null) throw new Error('the relay did not start');
  const base = `http://127.0.0.1:${running.port}`;
  return {
    ...running,
    url: `ws://127.0.0.1:${running.port}/v1/ws`,
    base,
    probe,
    log,
    recorded,
    stop: async () => {
      running.readiness.stop();
      for (const c of running.server.connections()) c.terminate();
      await running.server.close();
    },
  };
}

/** A client connection and what it saw. */
export interface Client {
  ws: WebSocket;
  /** Text messages, parsed. */
  messages: Record<string, unknown>[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string; at: number }>;
}

/** Connects to `url` offering `protocols` (default centcom.v1). */
export function connect(
  url: string,
  options: { protocols?: string[]; headers?: Record<string, string> } = {},
): Client {
  const ws = new WebSocket(url, options.protocols ?? [SUBPROTOCOL], {
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
  ws.on('error', () => undefined);
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
  opened.catch(() => undefined);
  const closed = new Promise<{ code: number; reason: string; at: number }>((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason), at: Date.now() })),
  );
  return { ws, messages, opened, closed };
}

/** The HTTP status an upgrade gets, or 101 when it is accepted. */
export function upgradeStatus(
  url: string,
  options: { protocols?: string[]; headers?: Record<string, string> } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options.protocols ?? [SUBPROTOCOL], {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
    ws.once('open', () => {
      ws.terminate();
      resolve(101);
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.on('error', () => undefined);
  });
}

/** Waits until `predicate` holds, polling every 5 ms, or throws after `ms`. */
export async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
