/**
 * The alerting configuration against the real tools (B094), where a container runtime is reachable
 * (CI's test job):
 *
 * - promtool: every rule file passes `check rules` and every unit test file passes `test rules`
 *   (the card's 1.44 % fast burn, 0.2 % quiet and 15-minute dead letter cases among them);
 * - amtool: the committed and a rendered routing config pass `check-config`, and
 *   `config routes test` sends pages to the primary, the fallback and the secondary, tickets and
 *   info to their own receivers, and B092's deploy marker nowhere;
 * - a running Alertmanager with every receiver pointed at a webhook stub and every routing duration
 *   divided by SCALE (1 s stands for 10 minutes): a page reaches the primary once and repeats no
 *   sooner than 4 hours later, reaches the fallback after 5 minutes and the secondary after 15
 *   unless acknowledged (silenced) first; tickets and info never reach a pager; the deploy marker
 *   inhibits RelayConnectionDrop in its environment only; and a storm of pages across three
 *   services is three pages.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  HOST_FROM_CONTAINER,
  runAmtool,
  runPromtool,
  startAlertmanager,
  testcontainersRuntime,
  type TestAlertmanager,
} from '@centcom/testkit';
import { parse, stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promtoolRuns } from '../promtool.mjs';
import { CONFIG_FILE, CONTACT_POINTS, renderAlertmanager, TEMPLATE_FILE } from '../render.mjs';
import { minutes, REPO, type Route } from './helpers.js';

const RUNTIME = await testcontainersRuntime.check().then(
  () => true,
  () => false,
);
const config = readFileSync(CONFIG_FILE, 'utf8');
const template = readFileSync(TEMPLATE_FILE, 'utf8');

describe.runIf(RUNTIME)('promtool', () => {
  it('checks every rule file and passes every unit test', async () => {
    const [check, test] = promtoolRuns();
    const files = Object.fromEntries(
      [...(check ?? []).slice(2), ...(test ?? []).slice(2)].map((f) => [
        f,
        readFileSync(join(REPO, f), 'utf8'),
      ]),
    );
    const checked = await runPromtool(files, check ?? []);
    expect(checked.exitCode, checked.output).toBe(0);
    const tested = await runPromtool(files, test ?? []);
    expect(tested.exitCode, tested.output).toBe(0);
  }, 300_000);
});

describe.runIf(RUNTIME)('amtool', () => {
  const rendered = renderAlertmanager({
    config,
    template,
    env: {
      ALERT_CONTACT_PAGER_PRIMARY: `pagerduty:${'0'.repeat(32)}`,
      ALERT_CONTACT_PAGER_SECONDARY: `opsgenie:${'1'.repeat(24)}`,
      ALERT_CONTACT_FALLBACK: 'slack:https://hooks.slack.example/services/T0/B0/x',
      ALERT_CONTACT_TICKET: 'webhook:http://tickets.internal:8080/alerts',
      ALERT_CONTACT_INFO: 'email:oncall@example.com',
      ALERT_SMTP_SMARTHOST: 'smtp.example.com:587',
      ALERT_SMTP_FROM: 'alerts@example.com',
      ALERT_GRAFANA_URL: 'https://grafana.example.test',
      ALERT_RUNBOOK_BASE_URL: 'https://github.com/example/repo/blob/main/',
    },
  });

  it('accepts the committed config and a rendered one with every kind of contact point', async () => {
    for (const files of [
      { 'alertmanager.yml': config, 'centcom.tmpl': template },
      { 'alertmanager.yml': rendered.config, 'centcom.tmpl': rendered.template },
    ]) {
      const result = await runAmtool(files, ['check-config', 'alertmanager.yml']);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain('SUCCESS');
    }
  }, 300_000);

  it.each([
    [
      ['alertname=ApiAvailabilityFastBurn', 'severity=page', 'service=api'],
      'pager-primary,fallback,pager-secondary',
    ],
    [
      ['alertname=ObservabilityDown', 'severity=page', 'service=platform'],
      'fallback,pager-primary,pager-secondary',
    ],
    [['alertname=RelayOverloaded', 'severity=ticket', 'service=relay'], 'ticket'],
    [['alertname=SomethingInformative', 'severity=info', 'service=platform'], 'info'],
    [['alertname=DeployInProgress', 'deploy_in_progress=true', 'service=relay'], 'blackhole'],
  ])(
    'routes %j to %s',
    async (labels, receivers) => {
      const result = await runAmtool({ 'alertmanager.yml': config, 'centcom.tmpl': template }, [
        'config',
        'routes',
        'test',
        '--config.file=alertmanager.yml',
        `--verify.receivers=${receivers}`,
        ...labels,
        'env=prod',
      ]);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain(receivers);
    },
    300_000,
  );
});

/** 1 s of test time stands for SCALE s of production time: 4 h is 24 s, 15 minutes 1.5 s. */
const SCALE = 600;
const scaledMs = (duration: string): number => (minutes(duration) * 60_000) / SCALE;
const PAGERS = ['pager-primary', 'pager-secondary', 'fallback'];

/** `route` with every duration divided by SCALE. */
function scaleRoute(route: Route): Route {
  const scaled = { ...route };
  for (const key of ['group_wait', 'group_interval', 'repeat_interval'] as const) {
    const value = route[key];
    if (value !== undefined) scaled[key] = `${Math.max(1, Math.round(scaledMs(value)))}ms`;
  }
  if (route.routes !== undefined) scaled.routes = route.routes.map(scaleRoute);
  return scaled;
}

/** One webhook the stub received. */
interface Notification {
  receiver: string;
  /** Milliseconds after the alerts were posted. */
  at: number;
  status: string;
  groupLabels: Record<string, string>;
  alerts: { labels: Record<string, string> }[];
}

describe.runIf(RUNTIME)('a running Alertmanager, durations divided by 600', () => {
  const received: Notification[] = [];
  let t0 = 0;
  let ackedAt = 0;
  let am: TestAlertmanager | undefined;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => void (body += String(chunk)));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body) as Omit<Notification, 'at'>;
        received.push({ ...payload, at: Date.now() - t0 });
      } catch {
        received.push({
          receiver: 'unparsable',
          at: Date.now() - t0,
          status: '',
          groupLabels: {},
          alerts: [],
        });
      }
      res.writeHead(200).end();
    });
  });

  const labelsOf = (alertname: string, severity: string, service: string, env: string) => ({
    alertname,
    severity,
    service,
    env,
  });
  const alert = (labels: Record<string, string>) => ({
    labels,
    annotations: { summary: 'routing test' },
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  async function post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${am?.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${path}: ${res.status} ${await res.text()}`).toBe(true);
  }
  const notes = (receiver: string, env: string) =>
    received.filter((n) => n.receiver === receiver && n.groupLabels['env'] === env);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const env: Record<string, string> = {
      ALERT_GRAFANA_URL: 'https://grafana.example.test',
      ALERT_RUNBOOK_BASE_URL: 'https://github.com/example/repo/blob/main/',
    };
    for (const [receiver, variable] of Object.entries(CONTACT_POINTS)) {
      env[variable] = `webhook:http://${HOST_FROM_CONTAINER}:${port}/${receiver}`;
    }
    const rendered = renderAlertmanager({ config, template, env });
    const doc = parse(rendered.config) as { route: Route };
    doc.route = scaleRoute(doc.route);
    am = await startAlertmanager(
      { 'alertmanager.yml': stringify(doc), 'centcom.tmpl': rendered.template },
      { hostPorts: [port] },
    );

    // Inhibition sources first: B092's deploy marker in env d, and the storm's pages in env f.
    t0 = Date.now();
    await post('/api/v2/alerts', [
      alert({
        alertname: 'DeployInProgress',
        deploy_in_progress: 'true',
        service: 'relay',
        env: 'd',
      }),
      ...[
        ['ApiAvailabilityFastBurn', 'api'],
        ['ApiLatencyBurn', 'api'],
        ['StripeWebhookLag', 'api'],
        ['RelayConnectBurn', 'relay'],
        ['RelayFanoutBurn', 'relay'],
        ['ResumeFailureBurn', 'relay'],
        ['DeadLetterNonEmpty', 'worker'],
        ['WebhookDeliveryFailing', 'worker'],
      ].map(([name, service]) => alert(labelsOf(name ?? '', 'page', service ?? '', 'f'))),
    ]);
    await sleep(300);

    t0 = Date.now();
    await post('/api/v2/alerts', [
      alert(labelsOf('ApiAvailabilityFastBurn', 'page', 'api', 'a')),
      alert(labelsOf('RelayConnectBurn', 'page', 'relay', 'b')),
      alert(labelsOf('CertExpirySoon', 'ticket', 'platform', 'c')),
      alert(labelsOf('SomethingInformative', 'info', 'platform', 'c')),
      alert({ ...labelsOf('RelayConnectionDrop', 'ticket', 'relay', 'd'), region: 'eu' }),
      alert({ ...labelsOf('RelayConnectionDrop', 'ticket', 'relay', 'e'), region: 'eu' }),
      alert(labelsOf('RelayOverloaded', 'ticket', 'relay', 'f')),
      alert(labelsOf('DbPoolSaturation', 'ticket', 'postgres', 'f')),
    ]);

    // Acknowledge the page in env b as soon as the primary has it.
    while (notes('pager-primary', 'b').length === 0 && Date.now() - t0 < 5_000) await sleep(10);
    const now = new Date();
    await post('/api/v2/silences', {
      matchers: [
        { name: 'alertname', value: 'RelayConnectBurn', isRegex: false, isEqual: true },
        { name: 'env', value: 'b', isRegex: false, isEqual: true },
      ],
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
      createdBy: 'b094-routing-test',
      comment: 'ack',
    });
    ackedAt = Date.now() - t0;

    // Past the first repeat: 4 h (24 s) after the first notification, plus a group interval.
    await sleep(scaledMs('4h') + 2 * scaledMs('5m') + 1_000);
  }, 300_000);

  afterAll(async () => {
    await am?.stop();
    await new Promise((resolve) => server.close(resolve));
  });

  it('pages the primary once, and again no sooner than 4 hours later', () => {
    const primary = notes('pager-primary', 'a');
    expect(primary.map((n) => n.status)).toEqual(['firing', 'firing']);
    const [first, second] = primary as [Notification, Notification];
    expect(first.at).toBeLessThan(scaledMs('15m'));
    // A small allowance for delivery jitter (about 2 minutes at this scale).
    expect(second.at - first.at).toBeGreaterThanOrEqual(scaledMs('4h') - 200);
  });

  it('escalates an unacknowledged page to the fallback after 5 minutes and the secondary after 15', () => {
    const fallback = notes('fallback', 'a');
    const secondary = notes('pager-secondary', 'a');
    expect(fallback.length).toBeGreaterThan(0);
    expect(secondary.length).toBeGreaterThan(0);
    expect(fallback[0]?.at).toBeGreaterThanOrEqual(scaledMs('5m'));
    expect(secondary[0]?.at).toBeGreaterThanOrEqual(scaledMs('15m'));
    expect(secondary[0]?.at).toBeLessThan(scaledMs('15m') + scaledMs('15m'));
  });

  it('does not escalate a page acknowledged within 5 minutes', () => {
    expect(ackedAt, 'the silence came too late to test the fallback').toBeLessThan(
      scaledMs('5m') - 50,
    );
    expect(notes('pager-primary', 'b')).toHaveLength(1);
    expect(notes('fallback', 'b')).toEqual([]);
    expect(notes('pager-secondary', 'b')).toEqual([]);
  });

  it('sends tickets and info alerts to their receivers and never to a pager', () => {
    expect(
      notes('ticket', 'c').flatMap((n) => n.alerts.map((a) => a.labels['alertname'])),
    ).toContain('CertExpirySoon');
    expect(notes('info', 'c').flatMap((n) => n.alerts.map((a) => a.labels['alertname']))).toContain(
      'SomethingInformative',
    );
    for (const env of ['c', 'd', 'e']) {
      for (const pager of PAGERS) expect(notes(pager, env), `${pager} ${env}`).toEqual([]);
    }
  });

  it('inhibits RelayConnectionDrop during a deploy in its environment only, and never notifies the marker', async () => {
    expect(notes('ticket', 'd')).toEqual([]);
    expect(
      notes('ticket', 'e').flatMap((n) => n.alerts.map((a) => a.labels['alertname'])),
    ).toContain('RelayConnectionDrop');
    const filter = ['alertname="RelayConnectionDrop"', 'env="d"']
      .map((m) => `filter=${encodeURIComponent(m)}`)
      .join('&');
    const res = await fetch(`${am?.url}/api/v2/alerts?${filter}`);
    const alerts = (await res.json()) as { status: { state: string; inhibitedBy: string[] } }[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status.state).toBe('suppressed');
    expect(alerts[0]?.status.inhibitedBy).toHaveLength(1);
    const names = received.flatMap((n) => n.alerts.map((a) => a.labels['alertname']));
    expect(names).not.toContain('DeployInProgress');
  });

  it('turns a storm of 8 pages over 3 services into 3 pages, holding back their tickets', () => {
    const storm = notes('pager-primary', 'f').filter(
      (n) => n.at < scaledMs('4h') - scaledMs('15m'),
    );
    expect(storm.map((n) => n.groupLabels['service']).sort()).toEqual(['api', 'relay', 'worker']);
    expect(storm.map((n) => n.alerts.length).sort()).toEqual([2, 3, 3]);
    const tickets = notes('ticket', 'f').flatMap((n) => n.alerts.map((a) => a.labels['alertname']));
    expect(tickets).toContain('DbPoolSaturation');
    expect(tickets).not.toContain('RelayOverloaded');
  });
});
