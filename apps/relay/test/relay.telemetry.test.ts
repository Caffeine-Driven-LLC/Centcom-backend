/**
 * The relay's telemetry (B093), through the catalogue bridge with in-memory exporters, as
 * `main.ts` wires it: after connections, frames, closes and a refused upgrade, the relay's own
 * catalogue metrics are exported under `centcom_*` (and nothing outside the catalogue), and each
 * connection is one span carrying its close code, never a frame or a payload.
 */
import { initTelemetry, METRIC_PREFIX, metricDef, METRICS, type MetricDef } from '@centcom/core';
import { createMemoryRedis } from '@centcom/core';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { RELAY_METRICS, startRelay, type RelayDb } from '../src/index.js';
import { captureLogger, connect, stubProbe, testConfig, until, upgradeStatus } from './helpers.js';

const SES = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

describe('relay telemetry', () => {
  it('exports the relay catalogue metrics and one span per connection', async () => {
    const spans = new InMemorySpanExporter();
    const metricsOut = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = initTelemetry({
      service: 'relay',
      version: '9.9.9',
      env: 'test',
      region: 'eu',
      config: { enabled: true, endpoint: 'http://127.0.0.1:9', sampleRatio: 1 },
      traceExporter: spans,
      metricExporter: metricsOut,
      metricIntervalMs: 60_000,
      strict: true,
    });
    const log = captureLogger();
    const running = await startRelay({
      config: testConfig(),
      host: '127.0.0.1',
      logger: log.logger,
      metrics: telemetry.metrics,
      tracer: telemetry.tracer,
      redis: createMemoryRedis(),
      db: {} as RelayDb,
      probe: stubProbe(),
      modules: [],
      build: { version: '9.9.9', contract_version: '1.0.0' },
    });
    if (running === null) throw new Error('the relay did not start');
    const { server } = running;
    // As main.ts registers it.
    telemetry.metrics.gauge(
      RELAY_METRICS.connectionsActive,
      () => server.gauges()[RELAY_METRICS.connectionsActive] ?? 0,
    );
    try {
      const clients = Array.from({ length: 10 }, () =>
        connect(`ws://127.0.0.1:${running.port}/v1/ws`),
      );
      await Promise.all(clients.map((c) => c.opened));
      for (const c of clients) {
        c.ws.send(
          JSON.stringify({
            v: 1,
            t: 'event',
            sid: SES,
            k: 'message.user',
            ct: 'secret-ciphertext',
          }),
        );
        c.ws.send('not json');
      }
      await until(() => server.gauges()[RELAY_METRICS.connectionsActive] === 10);
      expect(await upgradeStatus(`ws://127.0.0.1:${running.port}/not-the-socket`)).toBe(404);
      await telemetry.flush();
      for (const [i, c] of clients.entries()) c.ws.close(i % 2 === 0 ? 1000 : 4000);
      await Promise.all(clients.map((c) => c.closed));
      await until(() => running.registry.size === 0);
      await telemetry.flush();

      const exported = metricsOut
        .getMetrics()
        .flatMap((rm) => rm.scopeMetrics.flatMap((s) => s.metrics));
      const names = new Set(exported.map((m) => m.descriptor.name));
      const owned = (Object.entries(METRICS) as [string, MetricDef][])
        .filter(
          ([, def]) =>
            def.group === 'platform' && def.services.length === 1 && def.services[0] === 'relay',
        )
        .filter(([, def]) => def.planned === undefined && def.onFailure === undefined)
        .map(([name]) => `${METRIC_PREFIX}${name}`);
      expect(owned.sort()).toEqual([
        'centcom_relay_close_total',
        'centcom_relay_connections',
        'centcom_relay_connections_total',
        'centcom_relay_fanout_latency_seconds',
        'centcom_relay_frames_total',
        'centcom_relay_resume_duration_seconds',
        'centcom_relay_resume_total',
      ]);
      // Recorded by modules (none run here); their own tests cover them (fanout.isolation, resume.*).
      const byModules = new Set([
        'centcom_relay_fanout_latency_seconds',
        'centcom_relay_resume_duration_seconds',
        'centcom_relay_resume_total',
      ]);
      for (const name of [
        ...owned.filter((n) => !byModules.has(n)),
        'centcom_relay_upgrades_refused_total',
      ]) {
        expect(names.has(name), name).toBe(true);
      }
      for (const name of names)
        expect(metricDef(name.slice(METRIC_PREFIX.length)), name).toBeDefined();
      const frames = exported.find((m) => m.descriptor.name === 'centcom_relay_frames_total');
      expect(frames?.dataPoints.map((d) => d.attributes)).toEqual(
        expect.arrayContaining([
          { t: 'event', direction: 'in' },
          { t: 'invalid', direction: 'in' },
        ]),
      );

      await telemetry.flush();
      const connectionSpans = spans.getFinishedSpans().filter((s) => s.name === 'relay.connection');
      expect(connectionSpans).toHaveLength(10);
      expect(new Set(connectionSpans.map((s) => s.attributes['centcom.close_code']))).toEqual(
        new Set(['1000', 'other']),
      );
      expect(JSON.stringify(spans.getFinishedSpans())).not.toMatch(
        /secret-ciphertext|ses_|message\.user/,
      );
    } finally {
      for (const c of server.connections()) c.terminate();
      await server.close();
      running.readiness.stop();
      await telemetry.shutdown();
    }
  });
});
