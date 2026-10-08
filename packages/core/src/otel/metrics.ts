/**
 * The metrics bridge (B093): core's `Metrics` interface (B005) over an OpenTelemetry meter, held
 * to the catalogue (catalogue.ts). Every service records through it, so every exported metric is
 * `centcom_<name>` with catalogued labels only.
 *
 * A record the catalogue does not allow is not exported as given:
 * - an uncatalogued name, or one used as the wrong kind of instrument: dropped;
 * - a label the metric does not allow (or a forbidden one, FORBIDDEN_LABEL): left out;
 * - a label value that could identify someone (an id, an e-mail or IP address, a query): `redacted`;
 * - a label's 101st distinct value: `__overflow__` (cardinality guard, MAX_LABEL_VALUES).
 *
 * Each is counted in `otel_metric_violations_total{kind}` (once per distinct label set) and reported
 * to `onViolation` (logged once per metric and kind by the telemetry bootstrap). With `strict`
 * (tests and CI load runs) it throws a MetricViolationError naming the metric and label instead.
 *
 * Checked label sets are cached per metric (at most 1 000 each), so recording a series already seen
 * costs a map lookup: telemetry must not slow requests down.
 *
 * Owns: the bridge. Must not: export a label value it did not check.
 */
import type {
  Attributes,
  Counter as OtelCounter,
  Histogram as OtelHistogram,
  Meter,
} from '@opentelemetry/api';
import type { Counter, Histogram, MetricLabels, Metrics } from '../log/metrics.js';
import {
  exportedName,
  FORBIDDEN_LABEL,
  MAX_LABEL_VALUES,
  metricDef,
  type MetricDef,
  type MetricType,
} from './catalogue.js';
import { isUnsafeLabelValue } from './redact.js';

/** Why a record was not exported as given. */
export type ViolationKind =
  | 'uncatalogued'
  | 'wrong_type'
  | 'label_not_allowed'
  | 'forbidden_label'
  | 'value_redacted'
  | 'cardinality';

/** One refused or rewritten record. */
export interface MetricViolation {
  kind: ViolationKind;
  metric: string;
  label?: string;
}

/** Thrown for a violation in strict mode. */
export class MetricViolationError extends Error {
  constructor(readonly violation: MetricViolation) {
    super(
      `metric ${violation.metric}: ${violation.kind}${violation.label === undefined ? '' : ` (label ${violation.label})`}`,
    );
    this.name = 'MetricViolationError';
  }
}

/** A gauge's reading: one value, or values by label set. */
export type GaugeValue = number | readonly { value: number; labels?: MetricLabels }[];

/** `Metrics` plus gauges, which are read at each export. */
export interface TelemetryMetrics extends Metrics {
  gauge(name: string, read: () => GaugeValue | Promise<GaugeValue>): void;
}

/** Options of the bridge. */
export interface CatalogueMetricsOptions {
  /** Throw instead of rewriting (tests and load runs). */
  strict?: boolean;
  onViolation?(violation: MetricViolation): void;
}

const NOOP_COUNTER: Counter = Object.freeze({ inc: () => undefined });
/** Checked label sets kept per metric, at most. */
const ATTRIBUTE_CACHE_MAX = 1000;
const NO_LABELS: Attributes = Object.freeze({});
const NOOP_HISTOGRAM: Histogram = Object.freeze({ observe: () => undefined });

/** The bridge over `meter`. */
export function catalogueMetrics(
  meter: Meter,
  opts: CatalogueMetricsOptions = {},
): TelemetryMetrics {
  const counters = new Map<string, OtelCounter>();
  const histograms = new Map<string, OtelHistogram>();
  const gauges = new Set<string>();
  /** Values seen per metric and label. */
  const seen = new Map<string, Set<string>>();
  const violations = meter.createCounter(exportedName('otel_metric_violations_total'), {
    description: 'Metric records refused or rewritten by the catalogue.',
  });

  const violate = (violation: MetricViolation): void => {
    violations.add(1, { kind: violation.kind });
    opts.onViolation?.(violation);
    if (opts.strict === true) throw new MetricViolationError(violation);
  };

  const defOf = (name: string, type: MetricType): MetricDef | undefined => {
    const def = metricDef(name);
    if (def === undefined) {
      violate({ kind: 'uncatalogued', metric: name });
      return undefined;
    }
    if (def.type !== type) {
      violate({ kind: 'wrong_type', metric: name });
      return undefined;
    }
    return def;
  };

  const cache = new Map<string, Map<string, Attributes>>();

  /** `labels` checked against `def` (see the module comment), from the cache when seen before. */
  const attributes = (
    name: string,
    def: MetricDef,
    labels: MetricLabels | undefined,
  ): Attributes => {
    if (labels === undefined) return NO_LABELS;
    let forMetric = cache.get(name);
    if (forMetric === undefined) {
      forMetric = new Map();
      cache.set(name, forMetric);
    }
    const key = JSON.stringify(labels);
    const hit = forMetric.get(key);
    if (hit !== undefined) return hit;
    const checked = check(name, def, labels);
    if (forMetric.size < ATTRIBUTE_CACHE_MAX) forMetric.set(key, checked);
    return checked;
  };

  const check = (name: string, def: MetricDef, labels: MetricLabels): Attributes => {
    const out: Attributes = {};
    for (const [label, raw] of Object.entries(labels)) {
      if (!def.labels.includes(label)) {
        violate({
          kind: FORBIDDEN_LABEL.test(label) ? 'forbidden_label' : 'label_not_allowed',
          metric: name,
          label,
        });
        continue;
      }
      let value = String(raw);
      if (isUnsafeLabelValue(value)) {
        violate({ kind: 'value_redacted', metric: name, label });
        value = 'redacted';
      }
      const key = `${name}|${label}`;
      let values = seen.get(key);
      if (values === undefined) {
        values = new Set();
        seen.set(key, values);
      }
      if (!values.has(value)) {
        if (values.size >= MAX_LABEL_VALUES) {
          violate({ kind: 'cardinality', metric: name, label });
          value = '__overflow__';
        } else {
          values.add(value);
        }
      }
      out[label] = value;
    }
    return out;
  };

  return {
    counter(name, labels) {
      const def = defOf(name, 'counter');
      if (def === undefined) return NOOP_COUNTER;
      let instrument = counters.get(name);
      if (instrument === undefined) {
        instrument = meter.createCounter(exportedName(name), {
          unit: def.unit,
          description: def.help,
        });
        counters.set(name, instrument);
      }
      const attrs = attributes(name, def, labels);
      const target = instrument;
      return { inc: (n = 1) => target.add(n, attrs) };
    },
    histogram(name, buckets) {
      const def = defOf(name, 'histogram');
      if (def === undefined) return NOOP_HISTOGRAM;
      let instrument = histograms.get(name);
      if (instrument === undefined) {
        instrument = meter.createHistogram(exportedName(name), {
          unit: def.unit,
          description: def.help,
          advice: { explicitBucketBoundaries: [...buckets] },
        });
        histograms.set(name, instrument);
      }
      const target = instrument;
      return { observe: (value, labels) => target.record(value, attributes(name, def, labels)) };
    },
    gauge(name, read) {
      const def = defOf(name, 'gauge');
      if (def === undefined || gauges.has(name)) return;
      gauges.add(name);
      meter
        .createObservableGauge(exportedName(name), { unit: def.unit, description: def.help })
        .addCallback(async (result) => {
          let reading: GaugeValue;
          try {
            reading = await read();
          } catch {
            return; // a gauge that cannot be read is skipped for this export
          }
          if (typeof reading === 'number') {
            result.observe(reading);
            return;
          }
          for (const { value, labels } of reading)
            result.observe(value, attributes(name, def, labels));
        });
    },
  };
}
