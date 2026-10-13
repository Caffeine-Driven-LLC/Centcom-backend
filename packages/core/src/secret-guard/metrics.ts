/**
 * The guard's metrics (B101): `secret_guard_hits_total{surface,pattern}` and
 * `secret_guard_scan_seconds{surface}`, exported with the `centcom_` prefix (B093's bridge). Labels
 * are fixed ids only, never text.
 *
 * Alerting (see README): any hit on rest, frame, telemetry or backup pages the on-call (a client
 * bug or an attack); a log hit opens a ticket.
 */
import { noopMetrics, type Metrics } from '../log/metrics.js';

/** Where a hit was found. */
export type Surface = 'log' | 'rest' | 'frame' | 'telemetry' | 'backup' | 'ci';

/** Buckets of the scan-time histogram: 50 microseconds to 50 ms (the request budget is 20 ms). */
export const SCAN_SECONDS_BUCKETS: readonly number[] = Object.freeze([
  0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.02, 0.05,
]);

/** What the surfaces record through. */
export interface GuardMetrics {
  hit(surface: Surface, pattern: string): void;
  scanned(surface: Surface, seconds: number): void;
}

/** Wraps `metrics` (default: records nothing). A metrics failure never reaches the caller. */
export function guardMetrics(metrics: Metrics = noopMetrics): GuardMetrics {
  const histogram = metrics.histogram('secret_guard_scan_seconds', SCAN_SECONDS_BUCKETS);
  return {
    hit(surface, pattern) {
      try {
        metrics.counter('secret_guard_hits_total', { surface, pattern }).inc();
      } catch {
        // counting must never break the surface it protects
      }
    },
    scanned(surface, seconds) {
      try {
        histogram.observe(seconds, { surface });
      } catch {
        // see above
      }
    },
  };
}
