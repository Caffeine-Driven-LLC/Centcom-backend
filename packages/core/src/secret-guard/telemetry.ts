/**
 * Surface 3, telemetry ingest (B101): `guardTelemetryBatch` drops every event whose JSON holds a
 * provider credential and keeps the rest. The ingest lane counts the dropped ones under drop
 * reason `pii_pattern` and still answers 204, as CT-TELEMETRY requires.
 *
 * Owns: the per-event scan. Must not: reject the whole batch for one bad event, or keep an event
 * the scanner could not walk (it fails closed per event).
 */
import { performance } from 'node:perf_hooks';
import type { Logger } from '../log/logger.js';
import type { Metrics } from '../log/metrics.js';
import type { AllowList } from './allow.js';
import { guardMetrics } from './metrics.js';
import { SCAN_BUDGET_MS, scanJson } from './scan.js';

/** Options for `guardTelemetryBatch`. */
export interface GuardTelemetryOptions {
  allow?: AllowList;
  metrics?: Metrics;
  logger?: Logger;
}

/** The events of `events` that hold no credential, and how many were dropped. */
export function guardTelemetryBatch<T = unknown>(
  events: readonly T[],
  o: GuardTelemetryOptions = {},
): { clean: T[]; rejected: number } {
  const metrics = guardMetrics(o.metrics);
  const clean: T[] = [];
  let rejected = 0;
  for (const event of events) {
    const started = performance.now();
    let pattern: string | undefined;
    try {
      pattern = scanJson(event, {
        ...(o.allow === undefined ? {} : { allow: o.allow }),
        budgetMs: SCAN_BUDGET_MS,
      })[0]?.pattern;
    } catch {
      pattern = 'unscannable';
    }
    metrics.scanned('telemetry', (performance.now() - started) / 1000);
    if (pattern === undefined) {
      clean.push(event);
      continue;
    }
    rejected += 1;
    metrics.hit('telemetry', pattern);
    o.logger?.warn({ surface: 'telemetry', pattern }, 'secret_guard_hit');
  }
  return { clean, rejected };
}
