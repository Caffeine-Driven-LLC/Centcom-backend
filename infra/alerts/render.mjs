// @ts-check
/**
 * Renders the deployable Alertmanager config (B094): infra/alerts/alertmanager/alertmanager.yml
 * with each receiver's contact point taken from its environment variable, and centcom.tmpl with the
 * Grafana and runbook base URLs.
 *
 * Usage: node infra/alerts/render.mjs <out-dir>   (or `pnpm alerts:render <out-dir>`)
 * Writes <out-dir>/alertmanager.yml and <out-dir>/centcom.tmpl and prints their paths. A variable
 * that is missing or invalid fails the run, naming the variable, never its value. The output holds
 * secrets (routing keys, webhook URLs), so <out-dir> must be outside the repository; hand both files
 * to the Alertmanager (Mimir: `mimirtool alertmanager load alertmanager.yml centcom.tmpl`).
 *
 * Each contact point variable is `<kind>:<target>` (infra/alerts/README.md):
 * `pagerduty:<routing key>`, `opsgenie:<API key>`, `slack:<incoming webhook URL>`,
 * `webhook:<URL>`, `email:<address>` (with ALERT_SMTP_*), or `none` (the receiver notifies nobody).
 *
 * Owns: turning the environment into contact points. Must not: print or log a variable's value.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

/** The repository root. */
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
/** The committed config and template. */
export const CONFIG_FILE = join(REPO, 'infra/alerts/alertmanager/alertmanager.yml');
export const TEMPLATE_FILE = join(REPO, 'infra/alerts/alertmanager/centcom.tmpl');

/** Each receiver that notifies someone, and the variable naming its contact point. */
export const CONTACT_POINTS = Object.freeze({
  'pager-primary': 'ALERT_CONTACT_PAGER_PRIMARY',
  'pager-secondary': 'ALERT_CONTACT_PAGER_SECONDARY',
  fallback: 'ALERT_CONTACT_FALLBACK',
  ticket: 'ALERT_CONTACT_TICKET',
  info: 'ALERT_CONTACT_INFO',
});
/** Receivers that never notify anyone. */
export const SILENT_RECEIVERS = Object.freeze(['blackhole']);
/** Contact point kinds. */
export const KINDS = Object.freeze(['pagerduty', 'opsgenie', 'slack', 'webhook', 'email', 'none']);
/** The base URLs the template needs, and the placeholder each replaces. */
export const BASE_URLS = Object.freeze({
  ALERT_GRAFANA_URL: '${ALERT_GRAFANA_URL}',
  ALERT_RUNBOOK_BASE_URL: '${ALERT_RUNBOOK_BASE_URL}',
});

const TITLE = '{{ template "centcom.title" . }}';
const TEXT = '{{ template "centcom.text" . }}';
const KEY = /^[A-Za-z0-9-]{8,128}$/;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/;
const SMARTHOST = /^[A-Za-z0-9.-]+:\d{1,5}$/;
/** A base URL goes into template text: no braces, quotes, spaces or angle brackets. */
const SAFE_URL = /^https?:\/\/[^\s{}"'<>]+$/;

/** The render failed; `problems` name variables, never values. */
export class RenderError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`The Alertmanager config was not rendered:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'RenderError';
    this.problems = problems;
  }
}

/** @typedef {Record<string, string | undefined>} Env */
/** @typedef {{ name: string, [integrations: string]: unknown }} Receiver */

/**
 * True when `value` parses as a URL with one of `protocols`.
 * @param {string} value
 * @param {readonly string[]} protocols
 */
function isUrl(value, protocols) {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * The integrations of a receiver from `kind:target`, or a problem.
 * @param {string} variable
 * @param {string} value
 * @param {Env} env
 * @returns {{ integrations: Record<string, unknown> } | { problem: string }}
 */
function contactPoint(variable, value, env) {
  const sep = value.indexOf(':');
  const kind = sep < 0 ? value : value.slice(0, sep);
  const target = sep < 0 ? '' : value.slice(sep + 1);
  const severityIs = (/** @type {string} */ page, /** @type {string} */ other) =>
    `{{ if eq .CommonLabels.severity "page" }}${page}{{ else }}${other}{{ end }}`;
  switch (kind) {
    case 'none':
      return target === ''
        ? { integrations: {} }
        : { problem: `${variable}: none takes no target` };
    case 'pagerduty':
      return KEY.test(target)
        ? {
            integrations: {
              pagerduty_configs: [
                {
                  routing_key: target,
                  description: TITLE,
                  severity: severityIs('critical', 'warning'),
                  send_resolved: true,
                },
              ],
            },
          }
        : { problem: `${variable}: pagerduty needs a routing key (8-128 letters, digits, dashes)` };
    case 'opsgenie':
      return KEY.test(target)
        ? {
            integrations: {
              opsgenie_configs: [
                {
                  api_key: target,
                  message: TITLE,
                  description: TEXT,
                  priority: severityIs('P1', 'P3'),
                  send_resolved: true,
                },
              ],
            },
          }
        : { problem: `${variable}: opsgenie needs an API key (8-128 letters, digits, dashes)` };
    case 'slack':
      return isUrl(target, ['https:'])
        ? {
            integrations: {
              slack_configs: [{ api_url: target, title: TITLE, text: TEXT, send_resolved: true }],
            },
          }
        : { problem: `${variable}: slack needs an https incoming webhook URL` };
    case 'webhook':
      return isUrl(target, ['https:', 'http:'])
        ? { integrations: { webhook_configs: [{ url: target, send_resolved: true }] } }
        : { problem: `${variable}: webhook needs an http(s) URL` };
    case 'email': {
      if (!EMAIL.test(target)) return { problem: `${variable}: email needs an address` };
      const smarthost = env['ALERT_SMTP_SMARTHOST'] ?? '';
      const from = env['ALERT_SMTP_FROM'] ?? '';
      const username = env['ALERT_SMTP_USERNAME'] ?? '';
      const password = env['ALERT_SMTP_PASSWORD'] ?? '';
      if (!SMARTHOST.test(smarthost)) {
        return { problem: `${variable}: email needs ALERT_SMTP_SMARTHOST as host:port` };
      }
      if (!EMAIL.test(from)) return { problem: `${variable}: email needs ALERT_SMTP_FROM` };
      if ((username === '') !== (password === '')) {
        return {
          problem: `${variable}: set both ALERT_SMTP_USERNAME and ALERT_SMTP_PASSWORD, or neither`,
        };
      }
      return {
        integrations: {
          email_configs: [
            {
              to: target,
              from,
              smarthost,
              ...(username === '' ? {} : { auth_username: username, auth_password: password }),
              require_tls: true,
              headers: { Subject: TITLE },
              text: TEXT,
              send_resolved: true,
            },
          ],
        },
      };
    }
    default:
      return { problem: `${variable}: the kind must be one of ${KINDS.join(', ')}` };
  }
}

/**
 * Renders `config` (the committed alertmanager.yml) and `template` (centcom.tmpl) with `env`.
 * Throws RenderError listing every problem.
 * @param {{ config: string, template: string, env: Env }} input
 * @returns {{ config: string, template: string }}
 */
export function renderAlertmanager({ config, template, env }) {
  /** @type {string[]} */
  const problems = [];
  const parsed = /** @type {{ receivers?: Receiver[] }} */ (parse(config));
  const receivers = parsed.receivers ?? [];
  for (const receiver of receivers) {
    if (Object.keys(receiver).length !== 1) {
      problems.push(`receiver ${receiver.name} must have no integrations in the committed config`);
      continue;
    }
    if (SILENT_RECEIVERS.includes(receiver.name)) continue;
    const variable = /** @type {Record<string, string>} */ (CONTACT_POINTS)[receiver.name];
    if (variable === undefined) {
      problems.push(`receiver ${receiver.name} has no contact point variable`);
      continue;
    }
    const value = env[variable];
    if (value === undefined || value === '') {
      problems.push(`${variable} is not set`);
      continue;
    }
    const result = contactPoint(variable, value, env);
    if ('problem' in result) problems.push(result.problem);
    else Object.assign(receiver, result.integrations);
  }
  for (const name of Object.keys(CONTACT_POINTS)) {
    if (!receivers.some((r) => r.name === name)) problems.push(`receiver ${name} is missing`);
  }

  let text = template;
  for (const [variable, placeholder] of Object.entries(BASE_URLS)) {
    const value = env[variable] ?? '';
    if (!SAFE_URL.test(value) || !isUrl(value, ['https:', 'http:'])) {
      problems.push(`${variable} must be an http(s) URL`);
    } else if (variable === 'ALERT_RUNBOOK_BASE_URL' && !value.endsWith('/')) {
      problems.push(`${variable} must end with /`);
    } else {
      // Dashboard paths start with /, runbook paths do not.
      const base = variable === 'ALERT_GRAFANA_URL' ? value.replace(/\/+$/, '') : value;
      text = text.split(placeholder).join(base);
    }
  }

  if (problems.length > 0) throw new RenderError(problems);
  const header =
    '# Rendered by infra/alerts/render.mjs (B094) from infra/alerts/alertmanager/alertmanager.yml.\n' +
    '# Holds contact point secrets: never commit it.\n';
  return { config: header + stringify(parsed, { lineWidth: 0 }), template: text };
}

/**
 * The CLI; returns the exit code.
 * @param {string[]} args
 * @param {Env} env
 * @param {{ write?: (text: string) => void, error?: (text: string) => void }} [io]
 * @returns {number}
 */
export function main(args, env, io = {}) {
  const write = io.write ?? ((text) => void process.stdout.write(text));
  const error = io.error ?? ((text) => void process.stderr.write(text));
  const [outArg] = args;
  if (outArg === undefined || args.length !== 1) {
    error('Usage: node infra/alerts/render.mjs <out-dir>\n');
    return 2;
  }
  const out = resolve(outArg);
  const inside = relative(REPO, out);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    error('The output holds secrets: write it outside the repository.\n');
    return 2;
  }
  let rendered;
  try {
    rendered = renderAlertmanager({
      config: readFileSync(CONFIG_FILE, 'utf8'),
      template: readFileSync(TEMPLATE_FILE, 'utf8'),
      env,
    });
  } catch (err) {
    if (!(err instanceof RenderError)) throw err;
    error(`${err.message}\n`);
    return 1;
  }
  mkdirSync(out, { recursive: true });
  const configPath = join(out, 'alertmanager.yml');
  const templatePath = join(out, 'centcom.tmpl');
  writeFileSync(configPath, rendered.config, { mode: 0o600 });
  writeFileSync(templatePath, rendered.template);
  write(`${configPath}\n${templatePath}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
