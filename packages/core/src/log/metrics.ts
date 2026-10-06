/**
 * Metrics hook points (B005): the small interface services record counters and histograms
 * through, and a no-op default. The exporter and the metrics endpoint belong to a later
 * observability lane (B093), which supplies a real implementation.
 *
 * Owns: the Metrics interface. Must not: be given labels holding user, workspace or session ids,
 * raw URLs or any content; label values must come from small fixed sets (route templates,
 * methods, status classes).
 */

/** Label names to values. Values come from small fixed sets. */
export type MetricLabels = Readonly<Record<string, string>>;

/** A monotonically increasing count. */
export interface Counter {
  /** Adds `n` (default 1). */
  inc(n?: number): void;
}

/** A distribution of observed values, bucketed by upper bound. */
export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
}

/** Where services record metrics. Implementations cache series by name and labels. */
export interface Metrics {
  counter(name: string, labels?: MetricLabels): Counter;
  histogram(name: string, buckets: readonly number[]): Histogram;
}

const NOOP_COUNTER: Counter = Object.freeze({ inc: () => undefined });
const NOOP_HISTOGRAM: Histogram = Object.freeze({ observe: () => undefined });

/** Records nothing; the default until an exporter is wired in. */
export const noopMetrics: Metrics = Object.freeze({
  counter: () => NOOP_COUNTER,
  histogram: () => NOOP_HISTOGRAM,
});
