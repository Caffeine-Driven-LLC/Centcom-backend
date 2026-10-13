/** Surface 3, telemetry ingest (B101): one bad event of a hundred is dropped, the rest are kept. */
import { describe, expect, it } from 'vitest';
import { recordingMetrics } from '../../../test/log/helpers.js';
import { guardTelemetryBatch } from '../telemetry.js';
import { AWS_KEY } from '../../../test/secret-guard/helpers.js';

const event = (i: number, extra: Record<string, unknown> = {}) => ({
  name: 'app.start',
  n: i,
  props: { version: '1.2.3', ...extra },
});

describe('guardTelemetryBatch', () => {
  it('drops the one event that carries a secret and keeps the other 99', () => {
    const batch = Array.from({ length: 100 }, (_, i) =>
      i === 41 ? event(i, { note: AWS_KEY }) : event(i),
    );
    const m = recordingMetrics();
    const { clean, rejected } = guardTelemetryBatch(batch, { metrics: m.metrics });
    expect(rejected).toBe(1);
    expect(clean).toHaveLength(99);
    expect(clean.some((e) => e.n === 41)).toBe(false);
    expect(
      m.count('secret_guard_hits_total', {
        surface: 'telemetry',
        pattern: 'aws_access_key',
      }),
    ).toBe(1);
  });

  it('drops an event it cannot scan, and keeps an empty batch empty', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(guardTelemetryBatch([deep, event(1)])).toEqual({ clean: [event(1)], rejected: 1 });
    expect(guardTelemetryBatch([])).toEqual({ clean: [], rejected: 0 });
  });
});
