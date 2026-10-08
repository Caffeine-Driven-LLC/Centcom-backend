/**
 * The metric catalogue and its bridge (B093):
 *
 * - catalogue completeness: every metric name the services' source records is catalogued, and every
 *   catalogued module metric is still recorded somewhere (no stale entries); the card's platform
 *   metrics are all there, planned ones with the lane that will emit them;
 * - label allow-list: no catalogued label is a forbidden name;
 * - the bridge: `centcom_` names, labels held to the catalogue, unsafe values redacted, cardinality
 *   capped at 100 values per label, uncatalogued names dropped, violations counted, strict mode
 *   throwing with the offending metric and label; gauges and histogram buckets;
 * - the cardinality guard over a simulated 2 000-session run.
 */
import { describe, expect, it } from 'vitest';
import {
  catalogueMetrics,
  FORBIDDEN_LABEL,
  MAX_LABEL_VALUES,
  metricDef,
  METRIC_PREFIX,
  METRICS,
  MetricViolationError,
  type MetricDef,
  type MetricViolation,
} from '../../src/index.js';
import { read, sourceFiles, testMeter } from './helpers.js';

const defs = Object.entries(METRICS) as [string, MetricDef][];

/** Literals that look like metric names but are not (a usage field, a log field, docs). */
const NOT_METRICS = new Set(['relay_bytes', 'duration_ms', 'centcom_http_requests_total']);

/** Metric names recorded in the source: suffixed literals, and literal first arguments of recorders. */
function namesInSource(): Map<string, string> {
  const found = new Map<string, string>();
  const suffixed = /['`]([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:total|seconds|ms|bytes))['`]/g;
  const recorder = /\.(?:counter|histogram|gauge)\(\s*['`]([a-z][a-z0-9_]*)['`]/g;
  for (const file of sourceFiles()) {
    if (file.replace(/\\/g, '/').includes('/src/otel/')) continue;
    const text = read(file);
    for (const re of [suffixed, recorder]) {
      for (const m of text.matchAll(re)) {
        const name = m[1] ?? '';
        if (!NOT_METRICS.has(name) && !found.has(name)) found.set(name, file);
      }
    }
  }
  return found;
}

describe('the catalogue', () => {
  it('lists every metric the source records, and nothing the source dropped', async () => {
    const { RELAY_METRICS } = await import('@centcom/relay');
    const recorded = namesInSource();
    for (const name of Object.values(RELAY_METRICS))
      recorded.set(name, 'apps/relay/src/metrics.ts');
    const missing = [...recorded.keys()].filter((name) => metricDef(name) === undefined);
    expect(missing, 'record these in the catalogue').toEqual([]);
    const stale = defs
      .filter(([name, def]) => def.group === 'module' && !recorded.has(name))
      .map(([name]) => name);
    expect(stale, 'catalogued but no longer recorded').toEqual([]);
    expect(recorded.size).toBeGreaterThan(100);
  });

  it('has the card catalogue: HTTP, relay, jobs and queues, pool, Redis, Stripe, webhooks', () => {
    const card: Record<string, readonly string[]> = {
      http_requests_total: ['route', 'method', 'status_class'],
      http_request_duration_seconds: ['route', 'method'],
      relay_connections: [],
      relay_frames_total: ['t', 'direction'],
      relay_fanout_latency_seconds: [],
      relay_resume_total: ['result'],
      relay_close_total: ['code'],
      relay_outbound_buffer_bytes: [],
      job_duration_seconds: ['queue'],
      job_failed_total: ['queue'],
      queue_depth: ['queue'],
      queue_oldest_age_seconds: ['queue'],
      db_pool_connections: ['state'],
      redis_ping_seconds: [],
      stripe_webhook_lag_seconds: ['type'],
      webhook_deliveries_total: ['attempt', 'result'],
    };
    for (const [name, labels] of Object.entries(card)) {
      expect(metricDef(name)?.labels, name).toEqual(labels);
      expect(metricDef(name)?.group, name).toBe('platform');
    }
    for (const [name, def] of defs) {
      if (def.planned !== undefined) expect(def.planned, name).toMatch(/^B\d{3}$/);
      if (def.type === 'counter') expect(name, name).toMatch(/_total$/);
      if (def.type === 'histogram') expect(name, name).toMatch(/_(seconds|bytes|ms)$/);
      if (name.endsWith('_seconds'))
        expect(def.unit, name).toBe(def.type === 'histogram' || def.type === 'gauge' ? 's' : '');
      expect(def.services.length, name).toBeGreaterThan(0);
      expect(def.help, name).not.toBe('');
    }
  });

  it('allows no label that could hold an id, an address, a path or content', () => {
    for (const [name, def] of defs) {
      for (const label of def.labels) {
        expect(FORBIDDEN_LABEL.test(label), `${name}{${label}}`).toBe(false);
        expect(label, `${name}{${label}}`).toMatch(/^[a-z][a-z_]*$/);
      }
    }
    for (const bad of [
      'user',
      'user_id',
      'workspace_id',
      'session',
      'ses',
      'member_id',
      'device',
      'email',
      'ip',
      'path',
      'url',
      'branch',
      'body',
      'ct',
      'p',
      'token',
      'request_id',
      'trace_id',
    ]) {
      expect(FORBIDDEN_LABEL.test(bad), bad).toBe(true);
    }
  });
});

describe('the bridge', () => {
  it('exports catalogued metrics as centcom_* with their allowed labels', async () => {
    const { meter, read: collect } = testMeter();
    const metrics = catalogueMetrics(meter);
    metrics
      .counter('http_requests_total', { route: '/v1/me', method: 'GET', status_class: '2xx' })
      .inc();
    metrics
      .counter('http_requests_total', { route: '/v1/me', method: 'GET', status_class: '2xx' })
      .inc(2);
    metrics
      .histogram('http_request_duration_seconds', [0.1, 0.3, 1])
      .observe(0.2, { route: '/v1/me', method: 'GET' });
    metrics.gauge('relay_connections', () => 7);
    metrics.gauge('queue_depth', async () => [
      { value: 3, labels: { queue: 'email.send' } },
      { value: 0, labels: { queue: 'notify.dispatch' } },
    ]);
    metrics.gauge('db_pool_max_connections', () => {
      throw new Error('cannot read');
    });
    const got = await collect();
    expect(got).toEqual(
      expect.arrayContaining([
        {
          name: 'centcom_http_requests_total',
          attributes: { route: '/v1/me', method: 'GET', status_class: '2xx' },
          value: 3,
        },
        expect.objectContaining({
          name: 'centcom_http_request_duration_seconds',
          value: 1,
          boundaries: [0.1, 0.3, 1],
        }),
        { name: 'centcom_relay_connections', attributes: {}, value: 7 },
        { name: 'centcom_queue_depth', attributes: { queue: 'email.send' }, value: 3 },
        { name: 'centcom_queue_depth', attributes: { queue: 'notify.dispatch' }, value: 0 },
      ]),
    );
    expect(got.every((p) => p.name.startsWith(METRIC_PREFIX))).toBe(true);
    expect(got.some((p) => p.name === 'centcom_db_pool_max_connections')).toBe(false);
  });

  it('drops, rewrites and counts what the catalogue does not allow', async () => {
    const { meter, read: collect } = testMeter();
    const seen: MetricViolation[] = [];
    const metrics = catalogueMetrics(meter, { onViolation: (v) => seen.push(v) });
    metrics.counter('made_up_total').inc();
    metrics.histogram('http_requests_total', [1]).observe(1);
    metrics
      .counter('relay_close_total', {
        code: '1000',
        session_id: 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
        extra: 'x',
      })
      .inc();
    for (const value of [
      '/v1/users/usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      'alice@example.com',
      '10.1.2.3',
      '/v1/me?email=x',
      'x'.repeat(101),
    ]) {
      metrics
        .counter('http_requests_total', { route: value, method: 'GET', status_class: '2xx' })
        .inc();
    }
    const got = await collect();
    expect(
      seen.map((v) => `${v.kind} ${v.metric}${v.label === undefined ? '' : ` ${v.label}`}`),
    ).toEqual([
      'uncatalogued made_up_total',
      'wrong_type http_requests_total',
      'forbidden_label relay_close_total session_id',
      'label_not_allowed relay_close_total extra',
      ...Array(5).fill('value_redacted http_requests_total route'),
    ]);
    expect(got.find((p) => p.name === 'centcom_relay_close_total')?.attributes).toEqual({
      code: '1000',
    });
    expect(
      got.filter((p) => p.name === 'centcom_http_requests_total').map((p) => p.attributes['route']),
    ).toEqual(['redacted']);
    expect(JSON.stringify(got)).not.toMatch(/usr_|alice|10\.1\.2\.3|made_up/);
    const counted = got.filter((p) => p.name === 'centcom_otel_metric_violations_total');
    expect(Object.fromEntries(counted.map((p) => [p.attributes['kind'], p.value]))).toEqual({
      uncatalogued: 1,
      wrong_type: 1,
      forbidden_label: 1,
      label_not_allowed: 1,
      value_redacted: 5,
    });
  });

  it('caps every label at 100 values, and throws in strict mode naming the label', async () => {
    const { meter, read: collect } = testMeter();
    const metrics = catalogueMetrics(meter);
    for (let i = 0; i < 150; i += 1) {
      metrics.counter('status_probes_total', { component: `component-${i}`, ok: 'true' }).inc();
    }
    const values = new Set(
      (await collect())
        .filter((p) => p.name === 'centcom_status_probes_total')
        .map((p) => p.attributes['component']),
    );
    expect(values.size).toBe(MAX_LABEL_VALUES + 1);
    expect(values.has('__overflow__')).toBe(true);

    const strict = catalogueMetrics(testMeter().meter, { strict: true });
    for (let i = 0; i < MAX_LABEL_VALUES; i += 1) {
      strict.counter('status_probes_total', { component: `c-${i}`, ok: 'true' }).inc();
    }
    expect(() =>
      strict.counter('status_probes_total', { component: 'one-too-many', ok: 'true' }),
    ).toThrow(
      new MetricViolationError({
        kind: 'cardinality',
        metric: 'status_probes_total',
        label: 'component',
      }),
    );
    expect(() => strict.counter('relay_close_total', { code: '1000', user: 'usr_x' })).toThrow(
      /relay_close_total: forbidden_label \(label user\)/,
    );
  });

  it('keeps labels bounded over a simulated 2 000-session run', async () => {
    const { createRelayMetrics, FRAME_TYPES } = await import('@centcom/relay');
    const { meter, read: collect } = testMeter();
    const relay = createRelayMetrics(catalogueMetrics(meter, { strict: true }));
    const http = catalogueMetrics(meter, { strict: true });
    const codes = [1000, 1001, 1006, 4401, 4403, 4409, 4999, 3000, 1011];
    for (let s = 0; s < 2000; s += 1) {
      const session = `ses_01JA3Z8K2M5N7P9Q0R1S2T${String(s).padStart(4, '0')}`;
      relay.connectionOpened();
      for (const t of [...FRAME_TYPES, `t_${session}`, 'invalid'])
        relay.frameIn(FRAME_TYPES.includes(t) ? t : 'invalid');
      relay.closed(codes[s % codes.length] ?? 1000);
      // The request context plugin labels by route template, whatever the URL holds.
      http
        .counter('http_requests_total', {
          route: '/v1/sessions/:id',
          method: s % 2 === 0 ? 'GET' : 'POST',
          status_class: '2xx',
        })
        .inc();
    }
    const got = await collect();
    const valuesByLabel = new Map<string, Set<unknown>>();
    for (const p of got) {
      for (const [label, value] of Object.entries(p.attributes)) {
        const key = `${p.name}{${label}}`;
        if (!valuesByLabel.has(key)) valuesByLabel.set(key, new Set());
        valuesByLabel.get(key)?.add(value);
      }
    }
    for (const [key, values] of valuesByLabel) {
      expect(values.size, key).toBeLessThanOrEqual(MAX_LABEL_VALUES);
      for (const v of values) expect(String(v), key).not.toMatch(/ses_|usr_|wsp_/);
    }
    expect(got.find((p) => p.name === 'centcom_relay_connections_total')?.value).toBe(2000);
  });
});
