/**
 * The observability configuration against the real tools (B093), where a container runtime is
 * reachable (CI's test job):
 *
 * - the collector (infra/observability/collector/config.yaml, exporters swapped for `debug`):
 *   a sample span carrying authorization, cookie, ct, p, ticket, token, the client's address, an id
 *   and an e-mail address comes out with none of them; and metrics a service exports over OTLP
 *   arrive, labelled with env and region;
 * - Grafana: all five dashboards import without error;
 * - Prometheus: `promtool check rules` and `promtool test rules` pass (the 1.44 % error rate is a
 *   burn rate of 14.4 over 1 h).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPromtool, startCollector, startGrafana, testcontainersRuntime } from '@centcom/testkit';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { initTelemetry } from '../../src/index.js';
import { REPO } from './helpers.js';

const RUNTIME = await testcontainersRuntime.check().then(
  () => true,
  () => false,
);
const OBS = join(REPO, 'infra/observability');

/** The production collector config, writing to the `debug` exporter, deciding fast. */
function testCollectorConfig(): string {
  const config = parse(readFileSync(join(OBS, 'collector/config.yaml'), 'utf8')) as {
    processors: Record<string, Record<string, unknown>>;
    exporters: Record<string, unknown>;
    service: { pipelines: Record<string, { exporters: string[] }> };
  };
  config.exporters = { debug: { verbosity: 'detailed' } };
  for (const pipeline of Object.values(config.service.pipelines)) pipeline.exporters = ['debug'];
  const tail = config.processors['tail_sampling'];
  if (tail !== undefined) tail['decision_wait'] = '1s';
  const batch = config.processors['batch'];
  if (batch !== undefined) batch['timeout'] = '200ms';
  return stringify(config);
}

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** Resolves once `check` holds, polling every 250 ms; rejects after `ms`. */
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.runIf(RUNTIME)('observability tools in containers', () => {
  it('the collector redacts a sample span and receives OTLP metrics with env and region', async () => {
    const collector = await startCollector(testCollectorConfig());
    try {
      const span = {
        resourceSpans: [
          {
            resource: {
              attributes: [attr('service.name', 'centcom-api'), attr('host.ip', '10.9.8.7')],
            },
            scopeSpans: [
              {
                scope: { name: 'probe' },
                spans: [
                  {
                    traceId: '5b8efff798038103d269b633813fc60c',
                    spanId: 'eee19b7ec3c1b174',
                    name: 'redaction-probe',
                    kind: 2,
                    startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                    endTimeUnixNano: String(BigInt(Date.now() + 5) * 1_000_000n),
                    status: { code: 2 },
                    attributes: [
                      attr('http.route', '/v1/users/:id'),
                      attr('authorization', 'Bearer secret-bearer-value'),
                      attr('http.request.header.authorization', 'Bearer other-secret-value'),
                      attr('cookie', 'session=cookie-value'),
                      attr('ct', 'ciphertext-value'),
                      attr('p', 'plaintext-value'),
                      attr('ticket', 'ticket-value'),
                      attr('token', 'token-value'),
                      attr('x-api-token', 'header-token-value'),
                      attr('client.address', '203.0.113.9'),
                      attr('net.peer.ip', '203.0.113.10'),
                      attr(
                        'centcom.note',
                        'for usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W at alice@example.com',
                      ),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const res = await fetch(`${collector.otlpUrl}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(span),
      });
      expect(res.status).toBe(200);

      const telemetry = initTelemetry({
        service: 'api',
        version: '9.9.9',
        env: 'ci',
        region: 'eu',
        config: { enabled: true, endpoint: collector.otlpUrl, sampleRatio: 1 },
        strict: true,
      });
      telemetry.metrics
        .counter('http_requests_total', { route: '/v1/me', method: 'GET', status_class: '2xx' })
        .inc(3);
      await telemetry.flush();
      await telemetry.shutdown();

      await until(
        () =>
          collector.logs().includes('redaction-probe') &&
          collector.logs().includes('centcom_http_requests_total'),
        60_000,
      );
      const logs = collector.logs();
      for (const secret of [
        'secret-bearer-value',
        'other-secret-value',
        'cookie-value',
        'ciphertext-value',
        'plaintext-value',
        'ticket-value',
        'token-value',
        '203.0.113.9',
        '203.0.113.10',
        '10.9.8.7',
        'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
        'alice@example.com',
      ]) {
        expect(logs, secret).not.toContain(secret);
      }
      expect(logs).toContain('/v1/users/:id');
      expect(logs).toContain('usr_[id]');
      expect(logs).toContain('[email]');
      expect(logs).toMatch(/env: Str\(ci\)/);
      expect(logs).toMatch(/region: Str\(eu\)/);
    } finally {
      await collector.stop();
    }
  }, 300_000);

  it('Grafana imports all five dashboards', async () => {
    const grafana = await startGrafana();
    try {
      const files = readdirSync(join(OBS, 'dashboards')).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(5);
      for (const file of files) {
        const dashboard = JSON.parse(readFileSync(join(OBS, 'dashboards', file), 'utf8')) as {
          uid: string;
        };
        const res = await fetch(`${grafana.url}/api/dashboards/db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: grafana.authorization },
          body: JSON.stringify({ dashboard: { ...dashboard, id: null }, overwrite: true }),
        });
        const body = (await res.json()) as { status?: string };
        expect(res.status, `${file}: ${JSON.stringify(body)}`).toBe(200);
        expect(body.status, file).toBe('success');
        const back = await fetch(`${grafana.url}/api/dashboards/uid/${dashboard.uid}`, {
          headers: { authorization: grafana.authorization },
        });
        expect(back.status, file).toBe(200);
      }
    } finally {
      await grafana.stop();
    }
  }, 300_000);

  it('promtool checks the SLO rules and passes their unit tests', async () => {
    const files = {
      'rules.yaml': readFileSync(join(OBS, 'slo/rules.yaml'), 'utf8'),
      'rules.test.yaml': readFileSync(join(OBS, 'slo/rules.test.yaml'), 'utf8'),
    };
    const check = await runPromtool(files, ['check', 'rules', 'rules.yaml']);
    expect(check.exitCode, check.output).toBe(0);
    const test = await runPromtool(files, ['test', 'rules', 'rules.test.yaml']);
    expect(test.exitCode, test.output).toBe(0);
  }, 300_000);
});
