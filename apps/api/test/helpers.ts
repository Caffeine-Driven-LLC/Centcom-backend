/**
 * Test helpers for the request-context plugin (B005): a Fastify app with the plugin registered
 * first, a logger whose lines are captured, and a recording Metrics.
 */
import { Writable } from 'node:stream';
import { createLogger, type Logger, type MetricLabels, type Metrics } from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import {
  requestContextPlugin,
  type RequestContextOptions,
} from '../src/plugins/request-context.js';

/** Valid CT-IDS request ids. */
export const REQUEST_ID = 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
export const OTHER_REQUEST_ID = 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4X';
/** What every generated or echoed request id must look like (B005 acceptance 1). */
export const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A logger at trace level whose lines are kept. */
export function captureLogger(): {
  logger: Logger;
  raw: () => string;
  lines: () => Record<string, unknown>[];
  /** Only the access-log lines. */
  access: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ level: 'trace', service: 'api', version: 'test', destination });
  const raw = (): string => chunks.join('');
  const lines = (): Record<string, unknown>[] =>
    raw()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, raw, lines, access: () => lines().filter((l) => l['msg'] === 'http.request') };
}

/** A Metrics that records counter totals by name and labels, and every histogram observation. */
export function recordingMetrics(): {
  metrics: Metrics;
  count: (name: string, labels?: MetricLabels) => number;
  observations: { name: string; value: number; labels?: MetricLabels }[];
} {
  const key = (name: string, labels?: MetricLabels): string =>
    `${name}${JSON.stringify(labels ?? {})}`;
  const counts = new Map<string, number>();
  const observations: { name: string; value: number; labels?: MetricLabels }[] = [];
  return {
    metrics: {
      counter: (name, labels) => ({
        inc: (n = 1) => counts.set(key(name, labels), (counts.get(key(name, labels)) ?? 0) + n),
      }),
      histogram: (name) => ({
        observe: (value, labels) => {
          observations.push(labels === undefined ? { name, value } : { name, value, labels });
        },
      }),
    },
    count: (name, labels) => counts.get(key(name, labels)) ?? 0,
    observations,
  };
}

/**
 * A Fastify app (its own logger off, as the API runs it) with the plugin registered first, then
 * the routes `addRoutes` adds.
 */
export async function buildApp(
  addRoutes: (app: FastifyInstance, logger: Logger) => void,
  options: Partial<RequestContextOptions> = {},
): Promise<{ app: FastifyInstance } & ReturnType<typeof captureLogger>> {
  const captured = captureLogger();
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger, ...options });
  addRoutes(app, captured.logger);
  await app.ready();
  return { app, ...captured };
}
