/**
 * The metric label guard (B050; tests "privacy.metrics.test.ts", acceptance 6): `assertMetricLabels`
 * rejects a label named `sid` or `member`, a label the catalogue does not declare for the relay,
 * and a value that looks like an id or is too long; the relay's wrapped metrics drop such labels
 * (never written) and count `relay_privacy_violations_total{where="metric"}`. A running relay wraps
 * every module's metrics, so no `ses_` or `mem_` reaches a label (the canary run checks a full
 * simulator run).
 */
import { describe, expect, it } from 'vitest';
import { METRIC_LABELS } from '../../src/privacy/allowlists.js';
import { assertMetricLabels, guardMetrics, MetricLabelError } from '../../src/privacy/metrics.js';
import { recordingMetrics } from '../helpers.js';

describe('assertMetricLabels (acceptance 6)', () => {
  it('rejects sid, member, undeclared labels, id-like and long values', () => {
    const bad: Record<string, string>[] = [
      { sid: 'x' },
      { member: 'x' },
      { session_id: 'x' },
      { colour: 'blue' },
      { result: 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W' },
      { reason: 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W' },
      { reason: 'r'.repeat(65) },
    ];
    for (const labels of bad) {
      expect(() => assertMetricLabels('relay_x_total', labels), JSON.stringify(labels)).toThrow(
        MetricLabelError,
      );
    }
    expect(() =>
      assertMetricLabels('relay_x_total', { result: 'queued', reason: 'grace' }),
    ).not.toThrow();
    expect(METRIC_LABELS.has('sid')).toBe(false);
    expect(METRIC_LABELS.has('result')).toBe(true);
  });

  it('the wrapped metrics drop bad labels and count them', () => {
    const recorded = recordingMetrics();
    const metrics = guardMetrics(recorded.metrics);
    metrics
      .counter('relay_fanout_deliveries_total', {
        result: 'queued',
        sid: 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      })
      .inc();
    metrics.histogram('relay_cluster_lag_seconds', [1]).observe(1, { member: 'mem_x' });
    metrics.counter('relay_ok_total').inc();
    expect(recorded.series()).toContainEqual({
      name: 'relay_fanout_deliveries_total',
      labels: { result: 'queued' },
    });
    expect(JSON.stringify(recorded.series())).not.toMatch(/ses_|mem_/);
    expect(recorded.count('relay_privacy_violations_total', { where: 'metric' })).toBe(2);
  });
});
