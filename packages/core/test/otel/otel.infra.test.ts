/**
 * The observability configuration under infra/observability (B093), checked without containers:
 *
 * - the collector: redaction before anything else in every pipeline (authorization, cookie, ct, p,
 *   ticket, token, the client's address), tail sampling (every error, slow traces, 5 % of the rest),
 *   env and region labels, exporters from the environment only (no secret in the file);
 * - the dashboards: valid JSON, env and region variables, and every query naming catalogued
 *   metrics (`centcom_*`) or recorded SLO series only;
 * - the SLOs: the seven of the card, each well formed, on catalogued metrics, and rules.yaml
 *   generated from them (up to date).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkSlo, readSlos, RULES_FILE, SLO_DIR, sloRules } from '../../scripts/gen-slo-rules.js';
import { metricDef, METRIC_PREFIX } from '../../src/index.js';
import { REPO } from './helpers.js';

const OBS = join(REPO, 'infra/observability');
const collector = parse(readFileSync(join(OBS, 'collector/config.yaml'), 'utf8')) as {
  processors: Record<string, Record<string, unknown>>;
  exporters: Record<string, Record<string, unknown>>;
  service: {
    pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }>;
  };
};

/** The catalogued metric a `centcom_*` series name belongs to, if any. */
function catalogued(series: string): boolean {
  const name = series.slice(METRIC_PREFIX.length);
  if (metricDef(name) !== undefined) return true;
  const base = name.replace(/_(bucket|sum|count)$/, '');
  return metricDef(base)?.type === 'histogram';
}

describe('the collector', () => {
  it('redacts first in every pipeline, and drops the attributes the card names and the client address', () => {
    const pipelines = collector.service.pipelines;
    expect(Object.keys(pipelines).sort()).toEqual(['logs', 'metrics', 'traces']);
    for (const [name, p] of Object.entries(pipelines)) {
      expect(p.receivers, name).toEqual(['otlp']);
      expect(p.processors[0], name).toBe('memory_limiter');
      expect(p.processors[1], name).toBe('attributes/redact');
      expect(p.processors.at(-1), name).toBe('batch');
    }
    const actions = collector.processors['attributes/redact']?.['actions'] as {
      key?: string;
      pattern?: string;
      action: string;
    }[];
    const deleted = new Set(actions.filter((a) => a.action === 'delete').map((a) => a.key));
    for (const key of [
      'authorization',
      'cookie',
      'ct',
      'p',
      'ticket',
      'token',
      'client.address',
      'net.peer.ip',
      'network.peer.address',
    ]) {
      expect(deleted.has(key), key).toBe(true);
    }
    expect(actions.some((a) => a.pattern !== undefined && a.action === 'delete')).toBe(true);
    expect(pipelines['traces']?.processors).toContain('transform/scrub');
    expect(pipelines['metrics']?.processors).toContain('transform/labels');
  });

  it('keeps every error and slow trace and 5 % of the rest', () => {
    const tail = collector.processors['tail_sampling'] as {
      policies: { type: string; [k: string]: unknown }[];
    };
    const byType = Object.fromEntries(tail.policies.map((p) => [p.type, p]));
    expect(byType['status_code']).toMatchObject({ status_code: { status_codes: ['ERROR'] } });
    expect(byType['latency']).toMatchObject({ latency: { threshold_ms: 1000 } });
    expect(byType['probabilistic']).toMatchObject({ probabilistic: { sampling_percentage: 5 } });
    const traces = collector.service.pipelines['traces']?.processors ?? [];
    expect(traces.indexOf('tail_sampling')).toBeGreaterThan(traces.indexOf('attributes/redact'));
  });

  it('takes its endpoints and credentials from the environment only', () => {
    const text = readFileSync(join(OBS, 'collector/config.yaml'), 'utf8');
    for (const exporter of Object.values(collector.exporters)) {
      expect(String(exporter['endpoint'])).toMatch(/^\$\{env:[A-Z_]+\}$/);
      expect(String((exporter['headers'] as Record<string, string>)['authorization'])).toMatch(
        /^\$\{env:[A-Z_]+\}$/,
      );
    }
    expect(text).not.toMatch(/glc_|Basic [A-Za-z0-9+/=]{8,}|https?:\/\/[a-z0-9.-]+\.grafana\.net/);
  });
});

describe('the dashboards', () => {
  const files = readdirSync(join(OBS, 'dashboards'))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const recorded = new Set(
    [...readFileSync(RULES_FILE, 'utf8').matchAll(/record: (\S+)/g)].map((m) => m[1] ?? ''),
  );

  it('are the five of the card, with env and region variables', () => {
    expect(files).toEqual([
      'api-overview.json',
      'billing-stripe.json',
      'database-redis.json',
      'relay-overview.json',
      'workers-queues.json',
    ]);
    for (const file of files) {
      const dash = JSON.parse(readFileSync(join(OBS, 'dashboards', file), 'utf8')) as {
        uid: string;
        title: string;
        templating: { list: { name: string }[] };
        panels: unknown[];
      };
      expect(dash.uid, file).toMatch(/^centcom-[a-z-]+$/);
      expect(
        dash.templating.list.map((v) => v.name),
        file,
      ).toEqual(['datasource', 'env', 'region']);
      expect(dash.panels.length, file).toBeGreaterThan(4);
    }
  });

  it('query only catalogued metrics and recorded SLO series, filtered by env', () => {
    let queries = 0;
    for (const file of files) {
      const dash = JSON.parse(readFileSync(join(OBS, 'dashboards', file), 'utf8')) as {
        panels: { title: string; targets: { expr: string }[] }[];
        templating: { list: { type: string; query?: { query: string } | string }[] };
      };
      const exprs = [
        ...dash.panels.flatMap((p) =>
          p.targets.map((t) => ({ where: `${file} / ${p.title}`, expr: t.expr })),
        ),
        ...dash.templating.list.flatMap((v) =>
          v.type === 'query' && typeof v.query === 'object'
            ? [{ where: `${file} variable`, expr: v.query.query }]
            : [],
        ),
      ];
      for (const { where, expr } of exprs) {
        queries += 1;
        const series = [...expr.matchAll(/\b(centcom_[a-z0-9_]+|slo:[a-z_:0-9]+)/g)].map(
          (m) => m[1] ?? '',
        );
        expect(series.length, where).toBeGreaterThan(0);
        for (const name of series) {
          if (name.startsWith('slo:')) expect(recorded.has(name), `${where}: ${name}`).toBe(true);
          else expect(catalogued(name), `${where}: ${name}`).toBe(true);
        }
        if (!where.endsWith('variable')) expect(expr, where).toContain('env="$env"');
      }
    }
    expect(queries).toBeGreaterThan(40);
  });
});

describe('the SLOs', () => {
  it('are the seven of the card, on catalogued metrics', () => {
    const slos = readSlos();
    expect(slos.map((s) => [s.name, s.objective])).toEqual([
      ['api-availability', 0.999],
      ['api-latency', 0.95],
      ['relay-connect', 0.995],
      ['relay-fanout', 0.99],
      ['resume-success', 0.99],
      ['stripe-webhook', 0.99],
      ['webhook-delivery', 0.95],
    ]);
    for (const slo of slos) {
      expect(slo.window, slo.name).toBe('30d');
      for (const selector of [slo.sli.good, slo.sli.total]) {
        const name = /^(centcom_[a-z0-9_]+)/.exec(selector)?.[1] ?? '';
        expect(catalogued(name), `${slo.name}: ${selector}`).toBe(true);
      }
    }
    expect(readdirSync(SLO_DIR).filter((f) => f.endsWith('.slo.yaml'))).toHaveLength(7);
  });

  it('refuse a malformed SLO file', () => {
    const good = {
      name: 'x-slo',
      objective: 0.99,
      window: '30d',
      owner: 'platform',
      sli: { good: 'a', total: 'b' },
    };
    expect(checkSlo('ok.slo.yaml', good)).toEqual(good);
    for (const bad of [
      { ...good, objective: 1 },
      { ...good, window: 'a month' },
      { ...good, name: 'Bad Name' },
      { ...good, owner: '' },
      { ...good, sli: { good: 'a' } },
      { ...good, extra: true },
      null,
    ]) {
      expect(() => checkSlo('bad.slo.yaml', bad)).toThrow(/bad\.slo\.yaml/);
    }
  });

  it('have their recording rules generated and up to date (5m, 1h, 6h, 3d burn rates)', () => {
    const text = sloRules(readSlos());
    expect(readFileSync(RULES_FILE, 'utf8')).toBe(text);
    const rules = parse(text) as {
      groups: { name: string; rules: { record: string; labels: { slo: string } }[] }[];
    };
    expect(rules.groups).toHaveLength(7);
    for (const group of rules.groups) {
      expect(group.rules.map((r) => r.record)).toEqual([
        'slo:sli_error:ratio_rate5m',
        'slo:sli_error:ratio_rate1h',
        'slo:sli_error:ratio_rate6h',
        'slo:sli_error:ratio_rate3d',
        'slo:burn_rate:5m',
        'slo:burn_rate:1h',
        'slo:burn_rate:6h',
        'slo:burn_rate:3d',
      ]);
      expect(new Set(group.rules.map((r) => r.labels.slo))).toEqual(
        new Set([group.name.replace(/^slo-/, '')]),
      );
    }
  });
});
