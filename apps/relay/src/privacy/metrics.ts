/**
 * The relay's metric label guard (B050): a metric label must be one the catalogue declares for a
 * relay metric (`allowlists.ts`) and its value must not look like an id (`ses_…`, `mem_…`, …) or
 * carry content (longer than 64 characters). `assertMetricLabels` throws on anything else (tests,
 * tools); `guardMetrics` wraps the relay's metrics so a bad label is dropped in production,
 * never written, and counted (`relay_privacy_violations_total{where="metric"}`).
 *
 * Owns: the label check. Must not: let an id or content become a label.
 */
import type { Histogram, MetricLabels, Metrics } from '@centcom/core';
import { METRIC_LABELS } from './allowlists.js';

/** A value like a Centcom id. */
const ID_VALUE = /(?:^|[^a-z])[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}/;
/** Longest label value. */
export const MAX_LABEL_VALUE = 64;

/** A label refused, and why. */
export class MetricLabelError extends Error {
  override name = 'MetricLabelError';
}

/** The card's check: throws a MetricLabelError for a label the relay may not use. */
export function assertMetricLabels(name: string, labels: Readonly<Record<string, string>>): void {
  for (const [label, value] of Object.entries(labels)) {
    if (!METRIC_LABELS.has(label)) {
      throw new MetricLabelError(`${name}: label ${label} is not allowed`);
    }
    if (typeof value !== 'string' || value.length > MAX_LABEL_VALUE || ID_VALUE.test(value)) {
      throw new MetricLabelError(`${name}: the value of label ${label} is not allowed`);
    }
  }
}

/** The labels of `labels` that pass, the rest dropped; the count of dropped ones. */
function allowedLabels(
  name: string,
  labels: MetricLabels | undefined,
): [MetricLabels | undefined, number] {
  if (labels === undefined) return [undefined, 0];
  const kept: Record<string, string> = {};
  let dropped = 0;
  for (const [label, value] of Object.entries(labels)) {
    try {
      assertMetricLabels(name, { [label]: String(value) });
      kept[label] = String(value);
    } catch {
      dropped += 1;
    }
  }
  return [kept, dropped];
}

/** `base` with every label checked: bad ones dropped and counted, never written. */
export function guardMetrics(base: Metrics): Metrics {
  const violation = (count: number): void => {
    if (count > 0) base.counter('relay_privacy_violations_total', { where: 'metric' }).inc(count);
  };
  return {
    counter(name, labels) {
      const [kept, dropped] = allowedLabels(name, labels);
      violation(dropped);
      return base.counter(name, kept);
    },
    histogram(name, buckets): Histogram {
      const inner = base.histogram(name, buckets);
      return {
        observe(value, labels) {
          const [kept, dropped] = allowedLabels(name, labels);
          violation(dropped);
          inner.observe(value, kept);
        },
      };
    },
  };
}
