/**
 * The alerting policy (B094), checked without a container runtime:
 *
 * - the 18 named alerts carry severity, service, owner and a complete runbook;
 * - at most 10 alerts page, each with an SLO or an explicit user-impact statement;
 * - every alert has summary, impact and a dashboard URL template, and no annotation can show an
 *   id, an e-mail address or another label value, whatever labels a series carries;
 * - every B093 SLO has the fast and slow page tiers and the 3-day ticket tier;
 * - the promtool tests cover the card's cases, every SLO alert and at least 5 cause alerts, and
 *   their expected labels and annotations match the rules;
 * - routing (alertmanager.yml, walked as Alertmanager walks it): pages reach the primary at once,
 *   the fallback after 5 minutes and the secondary after 15, repeat every 4 hours; tickets and info
 *   never page; B092's deploy marker only inhibits RelayConnectionDrop;
 * - the on-call handbook has its sections and a tabletop drill record for the current release.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { lintAlerts, MAX_PAGE_ALERTS, REQUIRED_ALERTS, RUNBOOK_SECTIONS } from '../lint.mjs';
import { CONTACT_POINTS, SILENT_RECEIVERS } from '../render.mjs';
import { readSlos } from '../slo-windows.mjs';
import {
  expandAnnotation,
  minutes,
  readAlertRules,
  readPromtoolTests,
  REPO,
  route,
  type Route,
} from './helpers.js';

const rules = readAlertRules();
const sloNames = readSlos(REPO).map((s) => s.name);
const lint = lintAlerts();
const PAGERS = ['pager-primary', 'pager-secondary', 'fallback'];

describe('alerts', () => {
  it('all 18 named alerts exist with severity, service, owner and a complete runbook', () => {
    expect(lint.problems).toEqual([]);
    for (const name of REQUIRED_ALERTS) {
      const variants = rules.filter((r) => r.alert === name);
      expect(variants.length, name).toBeGreaterThan(0);
      for (const rule of variants) {
        expect(['page', 'ticket', 'info'], name).toContain(rule.labels['severity']);
        expect(rule.labels['service'], name).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(rule.labels['owner'], name).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(rule.labels['runbook'], name).toBe(`infra/runbooks/alerts/${name}.md`);
      }
      const runbook = readFileSync(join(REPO, `infra/runbooks/alerts/${name}.md`), 'utf8');
      for (const section of RUNBOOK_SECTIONS) expect(runbook, name).toContain(`\n## ${section}\n`);
    }
  });

  it('at most 10 alerts page, and every page has an SLO or a user-impact statement', () => {
    const pages = rules.filter((r) => r.labels['severity'] === 'page');
    const names = new Set(pages.map((r) => r.alert));
    expect(names.size).toBeLessThanOrEqual(MAX_PAGE_ALERTS);
    for (const rule of pages) {
      const slo = rule.labels['slo'];
      if (slo !== undefined) expect(sloNames, rule.alert).toContain(slo);
      else expect(rule.annotations['user_impact'], rule.alert).toMatch(/\w{3,}.{40,}/);
    }
  });

  it('have summary, impact and a dashboard URL template, and never show customer data', () => {
    const dashboards = new Set(
      ['api-overview', 'billing-stripe', 'database-redis', 'relay-overview', 'workers-queues'].map(
        (d) => `centcom-${d}`,
      ),
    );
    // Labels a series might carry, hostile ones included: annotations must not show any of them.
    const hostile: Record<string, string> = {
      env: 'prod',
      region: 'eu',
      queue: 'notify.dispatch.dlq',
      component: 'api',
      job: 'centcom/centcom-api',
      user_id: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      workspace_id: 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      session_id: 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      email: 'someone@example.com',
      instance: '10.1.2.3:9100',
    };
    for (const rule of rules) {
      for (const key of ['summary', 'impact', 'dashboard']) {
        expect(rule.annotations[key], `${rule.alert} ${key}`).toBeTruthy();
      }
      const dashboard = /^\/d\/([a-z0-9-]+)\?var-env=\{\{ \$labels\.env \}\}$/.exec(
        rule.annotations['dashboard'] ?? '',
      );
      expect(dashboard?.[1] !== undefined && dashboards.has(dashboard[1]), rule.alert).toBe(true);
      for (const [key, text] of Object.entries(rule.annotations)) {
        const shown = expandAnnotation(text, hostile);
        expect(shown, `${rule.alert} ${key}`).not.toMatch(/[a-z]{3}_[0-9A-Z]{26}|@|10\.1\.2\.3/);
      }
    }
  });

  it('give every B093 SLO a fast and a slow page and a 3-day ticket', () => {
    const tier = (slo: string, window: string, threshold: string) =>
      new RegExp(
        `round\\(slo:burn_rate:${window}\\{slo="${slo}"\\}, 0\\.001\\) >= ${threshold}\\b`,
      );
    expect(sloNames).toHaveLength(7);
    for (const slo of sloNames) {
      const pages = rules.filter((r) => r.labels['slo'] === slo && r.labels['severity'] === 'page');
      const tickets = rules.filter(
        (r) => r.labels['slo'] === slo && r.labels['severity'] === 'ticket',
      );
      const pageExpr = pages.map((r) => r.expr).join('\n');
      const ticketExpr = tickets.map((r) => r.expr).join('\n');
      for (const [window, threshold] of [
        ['1h', '14.4'],
        ['5m', '14.4'],
        ['6h', '6'],
        ['30m', '6'],
      ] as const) {
        expect(pageExpr, `${slo} ${window}`).toMatch(tier(slo, window, threshold));
      }
      expect(ticketExpr, `${slo} 3d`).toMatch(tier(slo, '3d', '3'));
    }
  });
});

describe('promtool tests', () => {
  const tests = readPromtoolTests();
  const cases = [...tests.entries()].flatMap(([file, doc]) =>
    doc.tests.flatMap((group) => (group.alert_rule_test ?? []).map((t) => ({ file, group, ...t }))),
  );

  it('exist for every rule file and load the SLO recording rules', () => {
    for (const file of new Set(rules.map((r) => r.file))) {
      const service = file.replace(/(\.nonprod)?\.rules\.yaml$/, '');
      const doc = tests.get(`${service}.test.yaml`);
      expect(doc?.rule_files, file).toEqual([
        '../../observability/slo/rules.yaml',
        '../recording/slo-30m.rules.yaml',
        file,
      ]);
    }
  });

  it("expect each alert with exactly its rule's labels and annotations", () => {
    for (const c of cases) {
      for (const exp of c.exp_alerts) {
        const matching = rules.filter(
          (r) => r.alert === c.alertname && r.labels['severity'] === exp.exp_labels['severity'],
        );
        expect(matching, `${c.file} ${c.alertname}`).toHaveLength(1);
        const rule = matching[0];
        if (rule === undefined) continue;
        for (const [key, value] of Object.entries(rule.labels)) {
          expect(exp.exp_labels[key], `${c.file} ${c.alertname} ${key}`).toBe(value);
        }
        const annotations = Object.fromEntries(
          Object.entries(rule.annotations).map(([k, v]) => [
            k,
            expandAnnotation(v, exp.exp_labels),
          ]),
        );
        expect(exp.exp_annotations, `${c.file} ${c.alertname}`).toEqual(annotations);
      }
    }
  });

  it("cover the card's cases: 1.44 % for 1 h fires the fast burn, 0.2 % does not; a dead letter fires after 15 minutes", () => {
    const fired = (name: string, at: string) =>
      cases.filter((c) => c.alertname === name && c.eval_time === at);
    const fast = fired('ApiAvailabilityFastBurn', '60m');
    const values = (c: (typeof cases)[number]) =>
      c.group.input_series.map((s) => `${/status_class="(\dxx)"/.exec(s.series)?.[1]} ${s.values}`);
    const firing = fast.find((c) => c.exp_alerts.length === 1);
    expect(firing && values(firing)).toEqual(
      expect.arrayContaining(['2xx 0+9856x60', '5xx 0+144x60']),
    );
    const quiet = fast.find((c) => c.exp_alerts.length === 0);
    expect(quiet && values(quiet)).toEqual(
      expect.arrayContaining(['2xx 0+9980x60', '5xx 0+20x60']),
    );

    const dlq = cases.filter((c) => c.alertname === 'DeadLetterNonEmpty');
    const series = dlq[0]?.group.input_series.find((s) => s.series.includes('.dlq'));
    // 10 samples of 0, then 1 from 10m: the job arrives at 10m.
    expect(series?.values).toBe('0x9 1x30');
    expect(dlq.find((c) => c.eval_time === '24m')?.exp_alerts).toEqual([]);
    expect(dlq.find((c) => c.eval_time === '26m')?.exp_alerts).toHaveLength(1);
    expect(minutes('26m') - 10).toBeGreaterThan(15);
    expect(minutes('24m') - 10).toBeLessThan(15);
  });

  it('fire every SLO alert and at least 5 cause-based alerts', () => {
    const firing = new Set(
      cases.flatMap((c) =>
        c.exp_alerts.map(
          (e) => `${c.alertname}/${e.exp_labels['slo'] === undefined ? 'cause' : 'slo'}`,
        ),
      ),
    );
    for (const name of new Set(
      rules.filter((r) => r.labels['slo'] !== undefined).map((r) => r.alert),
    )) {
      expect(firing.has(`${name}/slo`), name).toBe(true);
    }
    const causes = new Set(rules.filter((r) => r.labels['slo'] === undefined).map((r) => r.alert));
    const tested = [...causes].filter((name) => firing.has(`${name}/cause`));
    expect(tested.length).toBeGreaterThanOrEqual(5);
  });
});

describe('routing', () => {
  const config = parse(
    readFileSync(join(REPO, 'infra/alerts/alertmanager/alertmanager.yml'), 'utf8'),
  ) as {
    route: Route;
    receivers: { name: string }[];
    inhibit_rules: { source_matchers: string[]; target_matchers: string[]; equal: string[] }[];
  };
  const routed = (labels: Record<string, string>) => route(config.route, labels);

  it('declares exactly the contact point receivers and a blackhole, none with integrations', () => {
    expect(config.receivers.map((r) => r.name).sort()).toEqual(
      [...Object.keys(CONTACT_POINTS), ...SILENT_RECEIVERS].sort(),
    );
    for (const receiver of config.receivers) expect(Object.keys(receiver)).toEqual(['name']);
    expect(config.route.group_by).toEqual(['env', 'service']);
  });

  it('pages the primary at once, the fallback after 5 minutes and the secondary after 15, every 4 hours', () => {
    for (const rule of rules.filter((r) => r.labels['severity'] === 'page')) {
      const labels = { ...rule.labels, alertname: rule.alert, env: 'prod' };
      const by = Object.fromEntries(routed(labels).map((r) => [r.receiver, r]));
      expect(Object.keys(by).sort(), rule.alert).toEqual([
        'fallback',
        'pager-primary',
        'pager-secondary',
      ]);
      expect(minutes(by['pager-primary']?.group_wait ?? ''), rule.alert).toBeLessThanOrEqual(1);
      expect(minutes(by['pager-secondary']?.group_wait ?? ''), rule.alert).toBe(15);
      const fallbackWait = rule.alert === 'ObservabilityDown' ? 0.5 : 5;
      expect(minutes(by['fallback']?.group_wait ?? ''), rule.alert).toBe(fallbackWait);
      for (const r of Object.values(by)) expect(minutes(r.repeat_interval), rule.alert).toBe(240);
    }
  });

  it('never pages for a ticket or an info alert', () => {
    const quiet = [
      ...rules.filter((r) => r.labels['severity'] !== 'page'),
      { alert: 'SomethingInformative', labels: { severity: 'info', service: 'platform' } },
    ];
    for (const rule of quiet) {
      const receivers = routed({ ...rule.labels, alertname: rule.alert, env: 'prod' }).map(
        (r) => r.receiver,
      );
      expect(receivers, rule.alert).toEqual([rule.labels['severity']]);
      for (const pager of PAGERS) expect(receivers).not.toContain(pager);
    }
  });

  it("sends B092's deploy marker nowhere and lets it inhibit RelayConnectionDrop in its environment", () => {
    expect(
      routed({ alertname: 'DeployInProgress', deploy_in_progress: 'true', env: 'prod' }).map(
        (r) => r.receiver,
      ),
    ).toEqual(['blackhole']);
    expect(config.inhibit_rules).toContainEqual({
      source_matchers: ['deploy_in_progress="true"'],
      target_matchers: ['alertname="RelayConnectionDrop"'],
      equal: ['env'],
    });
  });
});

describe('the on-call handbook', () => {
  const handbook = readFileSync(join(REPO, 'docs/ops/oncall.md'), 'utf8');

  it('covers rotation, handover, severities, incident roles, the status page, deploys and postmortems', () => {
    for (const heading of [
      '## Severities',
      '## Rotation',
      '### Handover',
      '## Incident roles',
      '## Status page updates',
      '## Deploy windows',
      '## Postmortems',
      '## Tabletop drills',
    ]) {
      expect(handbook).toContain(`\n${heading}\n`);
    }
    expect(handbook).toContain('/internal/admin/v1/incidents');
  });

  it('records a tabletop drill of 3 existing alerts for the current alerting release', () => {
    const release = /^Alerting release: (\S+)$/m.exec(
      readFileSync(join(REPO, 'infra/alerts/README.md'), 'utf8'),
    )?.[1];
    expect(release).toBeDefined();
    const drills = handbook.split('\n## Tabletop drills\n')[1] ?? '';
    const [, newest = ''] = drills.split(/\n(?=### \d{4}-\d{2}-\d{2}: )/);
    const date = /^### (\d{4}-\d{2}-\d{2}): /.exec(newest)?.[1] ?? '';
    expect(Number.isNaN(Date.parse(`${date}T00:00:00Z`))).toBe(false);
    expect(Date.parse(`${date}T00:00:00Z`)).toBeLessThanOrEqual(Date.now());
    expect(newest).toMatch(new RegExp(`^- Release: alerting ${release}$`, 'm'));
    const drilled = [
      ...(/^- Alerts .*$(?:\n {2}.*$)*/m.exec(newest)?.[0] ?? '').matchAll(/`([A-Za-z]+)`/g),
    ].map((m) => m[1]);
    expect(new Set(drilled).size).toBe(3);
    const names = new Set(rules.map((r) => r.alert));
    for (const name of drilled) expect(names.has(name ?? ''), name).toBe(true);
    expect(newest).not.toContain('- [ ]');
    expect(newest.match(/- \[x\]/g)?.length).toBe(5);
    expect(newest).toMatch(/- Findings and changes:\n {2}- \S/);
  });
});
