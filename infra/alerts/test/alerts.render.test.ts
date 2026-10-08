/**
 * `pnpm alerts:render` (B094): contact points come from environment variables, each kind becomes
 * its Alertmanager integration, a missing or malformed variable fails naming the variable but
 * never its value, and the output (which holds secrets) is refused inside the repository.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE,
  CONTACT_POINTS,
  main,
  RenderError,
  renderAlertmanager,
  TEMPLATE_FILE,
} from '../render.mjs';
import { REPO } from './helpers.js';

const config = readFileSync(CONFIG_FILE, 'utf8');
const template = readFileSync(TEMPLATE_FILE, 'utf8');
// Secret-shaped values are built at run time and low in entropy (no literal in the repository).
const KEY = '0'.repeat(32);
const OTHER_KEY = '1'.repeat(24);

/** A complete environment: one contact point of each kind. */
const env = (overrides: Record<string, string | undefined> = {}) => ({
  ALERT_CONTACT_PAGER_PRIMARY: `pagerduty:${KEY}`,
  ALERT_CONTACT_PAGER_SECONDARY: `opsgenie:${OTHER_KEY}`,
  ALERT_CONTACT_FALLBACK: 'slack:https://hooks.slack.example/services/T0/B0/x',
  ALERT_CONTACT_TICKET: 'webhook:http://tickets.internal:8080/alerts',
  ALERT_CONTACT_INFO: 'email:oncall@example.com',
  ALERT_SMTP_SMARTHOST: 'smtp.example.com:587',
  ALERT_SMTP_FROM: 'alerts@example.com',
  ALERT_GRAFANA_URL: 'https://grafana.example.test/',
  ALERT_RUNBOOK_BASE_URL: 'https://github.com/example/repo/blob/main/',
  ...overrides,
});

type Receiver = { name: string } & Record<string, Record<string, unknown>[]>;
const receivers = (text: string) =>
  Object.fromEntries((parse(text) as { receivers: Receiver[] }).receivers.map((r) => [r.name, r]));

/** The problems of a render that must fail. */
function problems(overrides: Record<string, string | undefined>): string[] {
  try {
    renderAlertmanager({ config, template, env: env(overrides) });
  } catch (err) {
    if (err instanceof RenderError) return err.problems;
    throw err;
  }
  throw new Error('rendered');
}

describe('renderAlertmanager', () => {
  it('turns each kind into its integration and keeps the routing as committed', () => {
    const out = renderAlertmanager({ config, template, env: env() });
    const r = receivers(out.config);
    expect(r['pager-primary']?.['pagerduty_configs']?.[0]).toMatchObject({
      routing_key: KEY,
      send_resolved: true,
    });
    expect(r['pager-secondary']?.['opsgenie_configs']?.[0]).toMatchObject({ api_key: OTHER_KEY });
    expect(r['fallback']?.['slack_configs']?.[0]).toMatchObject({
      api_url: 'https://hooks.slack.example/services/T0/B0/x',
    });
    expect(r['ticket']?.['webhook_configs']?.[0]).toEqual({
      url: 'http://tickets.internal:8080/alerts',
      send_resolved: true,
    });
    expect(r['info']?.['email_configs']?.[0]).toMatchObject({
      to: 'oncall@example.com',
      from: 'alerts@example.com',
      smarthost: 'smtp.example.com:587',
      require_tls: true,
    });
    expect(r['info']?.['email_configs']?.[0]).not.toHaveProperty('auth_password');
    expect(Object.keys(r['blackhole'] ?? {})).toEqual(['name']);
    const committed = parse(config) as Record<string, unknown>;
    const rendered = parse(out.config) as Record<string, unknown>;
    for (const key of ['route', 'inhibit_rules', 'templates', 'global']) {
      expect(rendered[key], key).toEqual(committed[key]);
    }
    expect(out.config).toMatch(
      /^# Rendered by .*\n# Holds contact point secrets: never commit it\.\n/,
    );
  });

  it('fills in the Grafana and runbook base URLs in the template', () => {
    const out = renderAlertmanager({ config, template, env: env() });
    expect(out.template).toContain(
      'Dashboard: https://grafana.example.test{{ .Annotations.dashboard }}',
    );
    expect(out.template).toContain(
      'Runbook: https://github.com/example/repo/blob/main/{{ .Labels.runbook }}',
    );
    expect(out.template).not.toContain('${');
  });

  it('adds SMTP credentials only as a pair, and a none receiver notifies nobody', () => {
    const secret = 'p'.repeat(12);
    const out = renderAlertmanager({
      config,
      template,
      env: env({
        ALERT_SMTP_USERNAME: 'alerts',
        ALERT_SMTP_PASSWORD: secret,
        ALERT_CONTACT_PAGER_SECONDARY: 'none',
      }),
    });
    const r = receivers(out.config);
    expect(r['info']?.['email_configs']?.[0]).toMatchObject({
      auth_username: 'alerts',
      auth_password: secret,
    });
    expect(Object.keys(r['pager-secondary'] ?? {})).toEqual(['name']);
    expect(problems({ ALERT_SMTP_USERNAME: 'alerts' })).toEqual([
      'ALERT_CONTACT_INFO: set both ALERT_SMTP_USERNAME and ALERT_SMTP_PASSWORD, or neither',
    ]);
  });

  it('names each missing or malformed variable, never its value', () => {
    const leaked = 'x'.repeat(40);
    const list = problems({
      ALERT_CONTACT_PAGER_PRIMARY: undefined,
      ALERT_CONTACT_PAGER_SECONDARY: `pagerduty:${leaked} spaces`,
      ALERT_CONTACT_FALLBACK: 'slack:http://insecure.example/hook',
      ALERT_CONTACT_TICKET: `carrier-pigeon:${leaked}`,
      ALERT_CONTACT_INFO: 'email:not-an-address',
      ALERT_GRAFANA_URL: 'https://grafana.example.test/{{ evil }}',
      ALERT_RUNBOOK_BASE_URL: 'https://github.com/example/repo/blob/main',
    });
    expect(list).toEqual([
      'ALERT_CONTACT_PAGER_PRIMARY is not set',
      'ALERT_CONTACT_PAGER_SECONDARY: pagerduty needs a routing key (8-128 letters, digits, dashes)',
      'ALERT_CONTACT_FALLBACK: slack needs an https incoming webhook URL',
      'ALERT_CONTACT_TICKET: the kind must be one of pagerduty, opsgenie, slack, webhook, email, none',
      'ALERT_CONTACT_INFO: email needs an address',
      'ALERT_GRAFANA_URL must be an http(s) URL',
      'ALERT_RUNBOOK_BASE_URL must end with /',
    ]);
    expect(list.join('\n')).not.toContain(leaked);
    expect(problems({ ALERT_SMTP_SMARTHOST: undefined })).toEqual([
      'ALERT_CONTACT_INFO: email needs ALERT_SMTP_SMARTHOST as host:port',
    ]);
    expect(problems({ ALERT_CONTACT_PAGER_SECONDARY: 'none:something' })).toEqual([
      'ALERT_CONTACT_PAGER_SECONDARY: none takes no target',
    ]);
  });

  it('refuses a committed config whose receivers already have integrations, or lack one', () => {
    const withSecret = config.replace(
      '  - name: ticket\n',
      "  - name: ticket\n    webhook_configs: [{ url: 'http://x.example' }]\n",
    );
    expect(() => renderAlertmanager({ config: withSecret, template, env: env() })).toThrow(
      /receiver ticket must have no integrations in the committed config/,
    );
    const missing = config.replace('  - name: info\n', '');
    expect(() => renderAlertmanager({ config: missing, template, env: env() })).toThrow(
      /receiver info is missing/,
    );
    expect(Object.values(CONTACT_POINTS)).toHaveLength(5);
  });
});

describe('the alerts:render CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b094-render-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes both files outside the repository and prints only their paths', () => {
    let out = '';
    const code = main([join(dir, 'out')], env(), {
      write: (t) => void (out += t),
      error: () => undefined,
    });
    expect(code).toBe(0);
    expect(out).toBe(
      `${join(dir, 'out', 'alertmanager.yml')}\n${join(dir, 'out', 'centcom.tmpl')}\n`,
    );
    expect(readFileSync(join(dir, 'out', 'alertmanager.yml'), 'utf8')).toContain(KEY);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'out', 'alertmanager.yml')).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses an output inside the repository, a missing argument, and an invalid environment', () => {
    let err = '';
    const io = { write: () => undefined, error: (t: string) => void (err += t) };
    expect(main([join(REPO, 'infra/alerts/out')], env(), io)).toBe(2);
    expect(err).toContain('outside the repository');
    expect(main([], env(), io)).toBe(2);
    expect(main([join(dir, 'bad')], env({ ALERT_CONTACT_INFO: undefined }), io)).toBe(1);
    expect(err).toContain('- ALERT_CONTACT_INFO is not set');
  });
});
