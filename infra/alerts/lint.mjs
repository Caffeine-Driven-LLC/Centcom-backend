// @ts-check
/**
 * The alert lint (B094), `pnpm alerts:lint`. Checks infra/alerts/ and infra/runbooks/alerts/:
 *
 * - rule files are `<service>.rules.yaml` or `<service>.nonprod.rules.yaml` (dev and stage only),
 *   hold alerting rules only, and each service's thresholds sit in one file;
 * - every alert has the labels `severity` (page, ticket or info), `service` (its file's),
 *   `owner` and `runbook` (`infra/runbooks/alerts/<alert>.md`, present, with every template
 *   section filled in), and the annotations `summary`, `impact` and `dashboard` (a path to a B093
 *   dashboard);
 * - annotations hold no customer data: no ids, e-mail addresses or label values other than env,
 *   region, queue, component and job;
 * - every metric an `expr` reads is in B093's catalogue, recorded by a rule file, or listed in
 *   exporters.yaml; `pending_metric: <lane>` lifts that for a lane's future metric, in non-prod
 *   files only;
 * - all 18 alerts the card names exist, at most 10 alerts page, and every page has an SLO (`slo`
 *   label) or a `user_impact` statement;
 * - the 30m SLO windows are up to date, every runbook's triage step has a command or a dashboard
 *   link, and relative links in the runbooks and on-call docs resolve.
 *
 * Usage: pnpm alerts:lint (tsx, to read the catalogue from @centcom/core). Exits 1 listing every
 * problem, else prints a summary.
 *
 * Owns: the checks. Must not: change a file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FORBIDDEN_LABEL, METRIC_PREFIX, METRICS } from '@centcom/core';
import { parse } from 'yaml';
import { readSlos, sloWindowRules, WINDOWS_FILE } from './slo-windows.mjs';

/** The repository root. */
export const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Where everything is, relative to the root. */
export const PATHS = Object.freeze({
  rules: 'infra/alerts/rules',
  recording: 'infra/alerts/recording',
  sloRules: 'infra/observability/slo/rules.yaml',
  exporters: 'infra/alerts/exporters.yaml',
  dashboards: 'infra/observability/dashboards',
  runbooks: 'infra/runbooks/alerts',
  template: 'infra/runbooks/alerts/_template.md',
  docs: Object.freeze(['docs/ops/oncall.md', 'infra/alerts/README.md']),
});

/** The alerts the card names (B094 interfaces); the list may grow, never shrink. */
export const REQUIRED_ALERTS = Object.freeze([
  'ApiAvailabilityFastBurn',
  'ApiAvailabilitySlowBurn',
  'ApiLatencyBurn',
  'RelayConnectBurn',
  'RelayFanoutBurn',
  'ResumeFailureBurn',
  'StripeWebhookLag',
  'DeadLetterNonEmpty',
  'PostgresReplicationLag',
  'DbPoolSaturation',
  'RedisMemoryHigh',
  'CertExpirySoon',
  'BackupStale',
  'RetentionJobFailed',
  'WebhookDeliveryFailing',
  'ReadyzFailing',
  'RelayOverloaded',
  'RelayConnectionDrop',
]);

export const SEVERITIES = Object.freeze(['page', 'ticket', 'info']);
/** At most this many alerts (by name) may page. */
export const MAX_PAGE_ALERTS = 10;
export const REQUIRED_LABELS = Object.freeze(['severity', 'service', 'owner', 'runbook']);
export const OPTIONAL_LABELS = Object.freeze(['slo']);
export const REQUIRED_ANNOTATIONS = Object.freeze(['summary', 'impact', 'dashboard']);
export const OPTIONAL_ANNOTATIONS = Object.freeze(['user_impact', 'pending_metric']);
/** The only labels an annotation may show: service-level, never an id. */
export const TEMPLATE_LABELS = Object.freeze(['env', 'region', 'queue', 'component', 'job']);
/** The runbook template's sections, in order. */
export const RUNBOOK_SECTIONS = Object.freeze([
  'Symptoms',
  'Impact',
  'Dashboards',
  'Triage commands',
  'Mitigation',
  'Escalation',
  'Verification',
  'Post-incident',
]);
/** Series Prometheus itself writes. */
export const BUILTIN_SERIES = Object.freeze(['ALERTS', 'ALERTS_FOR_STATE']);

const RULE_FILE = /^([a-z][a-z0-9-]*)(\.nonprod)?\.rules\.yaml$/;
const ALERT_NAME = /^[A-Z][A-Za-z0-9]+$/;
const OWNER = /^[a-z][a-z0-9-]*$/;
const DURATION = /^\d+[smhd]$/;
const DASHBOARD = /^\/d\/([a-z0-9-]+)(\?\S*)?$/;
const TEMPLATE = /\{\{(.*?)\}\}/g;
const TEMPLATE_LABEL = /^\s*\$labels\.([a-z_]+)\s*$/;
/** A Centcom id (prefix and ULID) or an e-mail address: customer data. */
const CUSTOMER_DATA = /\b[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}\b|[^\s@'"]+@[^\s@'"]+\.[A-Za-z]{2,}/;
const DASHBOARD_LINK = /\/d\/centcom-[a-z0-9-]+/;
const PROMQL_WORDS = new Set([
  'and',
  'or',
  'unless',
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'offset',
  'bool',
  'atan2',
  'inf',
  'nan',
]);

/**
 * @typedef {{ alert?: string, record?: string, expr?: string, for?: string,
 *   labels?: Record<string, unknown>, annotations?: Record<string, unknown> }} Rule
 * @typedef {{ name?: string, rules?: Rule[] }} Group
 * @typedef {{ file: string, service: string, nonprod: boolean, name: string, severity: string,
 *   labels: Record<string, string>, annotations: Record<string, string>, expr: string,
 *   for: string | undefined }} AlertRule
 * @typedef {{ problems: string[], alerts: AlertRule[], pageAlerts: string[], runbooks: string[] }} LintResult
 * @typedef {Record<string, { type: string }>} Catalogue
 */

/**
 * The exported series names of a catalogue: each metric with the prefix, histograms also as
 * `_bucket`, `_count` and `_sum`.
 * @param {Catalogue} [metrics]
 * @returns {Set<string>}
 */
export function catalogueSeries(metrics = METRICS) {
  const names = new Set();
  for (const [name, def] of Object.entries(metrics)) {
    const full = `${METRIC_PREFIX}${name}`;
    names.add(full);
    if (def.type === 'histogram') {
      for (const suffix of ['_bucket', '_count', '_sum']) names.add(`${full}${suffix}`);
    }
  }
  return names;
}

/**
 * The metric names a PromQL expression selects (not functions, keywords or label names).
 * @param {string} expr
 * @returns {string[]}
 */
export function metricNames(expr) {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  const names = new Set();
  for (const match of stripped.matchAll(/(?<![\w:.])([A-Za-z_:][\w:]*)(?![\w:])(?!\s*\()/g)) {
    const name = /** @type {string} */ (match[1]);
    if (!PROMQL_WORDS.has(name.toLowerCase())) names.add(name);
  }
  return [...names].sort();
}

/**
 * A Markdown document's `## ` sections, heading to trimmed body (fenced code included).
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function markdownSections(text) {
  /** @type {Map<string, string[]>} */
  const sections = new Map();
  /** @type {string[] | undefined} */
  let current;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = [];
      sections.set(/** @type {string} */ (heading[1]), current);
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join('\n').trim()]));
}

/**
 * The top-level numbered items of a Markdown list, each with its continuation lines.
 * @param {string} body
 * @returns {string[]}
 */
export function numberedItems(body) {
  /** @type {string[][]} */
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\d+\.\s/.test(line)) items.push([line]);
    else if (items.length > 0) /** @type {string[]} */ (items[items.length - 1]).push(line);
  }
  return items.map((lines) => lines.join('\n'));
}

/** True when `text` holds a command (code span or block) or a dashboard link. @param {string} text */
export const hasCommandOrDashboard = (text) =>
  /`[^`\n]+`|```/.test(text) || DASHBOARD_LINK.test(text);

/**
 * Problems with one runbook's text.
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
export function runbookProblems(file, text) {
  /** @type {string[]} */
  const problems = [];
  if (text.trim() === '') return [`${file}: empty`];
  const sections = markdownSections(text);
  for (const section of RUNBOOK_SECTIONS) {
    const body = sections.get(section);
    if (body === undefined) problems.push(`${file}: no "## ${section}" section`);
    else if (body === '') problems.push(`${file}: "## ${section}" is empty`);
  }
  const triage = sections.get('Triage commands');
  if (triage) {
    const steps = numberedItems(triage);
    if (steps.length === 0) problems.push(`${file}: triage commands must be a numbered list`);
    steps.forEach((step, i) => {
      if (!hasCommandOrDashboard(step)) {
        problems.push(`${file}: triage step ${i + 1} has no command or dashboard link`);
      }
    });
  }
  const verification = sections.get('Verification');
  if (verification && !hasCommandOrDashboard(verification)) {
    problems.push(`${file}: verification needs a command or dashboard link to check recovery`);
  }
  return problems;
}

/**
 * Relative Markdown links in `text` (a file at `file`, relative to `root`) that do not resolve.
 * @param {string} root
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
export function brokenLinks(root, file, text) {
  /** @type {string[]} */
  const problems = [];
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = /** @type {string} */ (match[1]);
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const path = target.split('#')[0] ?? '';
    if (!existsSync(join(root, dirname(file), path))) {
      problems.push(`${file}: the link to ${target} does not resolve`);
    }
  }
  return problems;
}

/**
 * @param {string} root
 * @param {string} path
 * @returns {unknown}
 */
const readYaml = (root, path) => parse(readFileSync(join(root, path), 'utf8'));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Lints the alerts under `root`.
 * @param {{ root?: string, catalogue?: Set<string> }} [options]
 * @returns {LintResult}
 */
export function lintAlerts({ root = REPO, catalogue = catalogueSeries() } = {}) {
  /** @type {string[]} */
  const problems = [];

  // What exprs may read, and what annotations and labels may name.
  const slos = new Set(readSlos(root).map((s) => s.name));
  const windows = sloWindowRules(readSlos(root));
  const windowsPath = join(root, WINDOWS_FILE);
  if (!existsSync(windowsPath) || readFileSync(windowsPath, 'utf8') !== windows) {
    problems.push(`${WINDOWS_FILE} is out of date: run node infra/alerts/slo-windows.mjs`);
  }
  const recorded = new Set();
  const recordingFiles = [
    PATHS.sloRules,
    ...readdirSync(join(root, PATHS.recording))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => `${PATHS.recording}/${f}`),
  ];
  for (const file of recordingFiles) {
    const doc = /** @type {{ groups?: Group[] }} */ (readYaml(root, file));
    for (const group of doc.groups ?? []) {
      for (const rule of group.rules ?? []) {
        if (typeof rule.record === 'string') recorded.add(rule.record);
        else problems.push(`${file}: holds an alert; recording files hold recording rules only`);
      }
    }
  }
  const exporters =
    /** @type {{ exporters?: Record<string, { metrics?: Record<string, string> }> }} */ (
      readYaml(root, PATHS.exporters)
    );
  const exported = new Set(
    Object.values(exporters.exporters ?? {}).flatMap((e) => Object.keys(e.metrics ?? {})),
  );
  const known = new Set([...catalogue, ...recorded, ...exported, ...BUILTIN_SERIES]);
  const dashboards = new Set(
    readdirSync(join(root, PATHS.dashboards))
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const dashboard = /** @type {{ uid?: string }} */ (
          JSON.parse(readFileSync(join(root, PATHS.dashboards, f), 'utf8'))
        );
        return dashboard.uid;
      }),
  );

  /** @type {AlertRule[]} */
  const alerts = [];
  /** @type {Map<string, string>} */
  const serviceFiles = new Map();
  const groupNames = new Set();
  const ruleFiles = readdirSync(join(root, PATHS.rules))
    .filter((f) => !f.endsWith('.test.yaml'))
    .sort();
  for (const name of ruleFiles) {
    const file = `${PATHS.rules}/${name}`;
    const fileMatch = RULE_FILE.exec(name);
    if (!fileMatch) {
      problems.push(`${file}: rule files are <service>.rules.yaml or <service>.nonprod.rules.yaml`);
      continue;
    }
    const service = /** @type {string} */ (fileMatch[1]);
    const nonprod = fileMatch[2] !== undefined;
    const other = serviceFiles.get(service);
    if (other !== undefined) {
      problems.push(
        `${file}: ${service}'s thresholds are already in ${other}; keep one file per service`,
      );
    }
    serviceFiles.set(service, file);
    const doc = readYaml(root, file);
    if (!isRecord(doc) || !Array.isArray(doc['groups'])) {
      problems.push(`${file}: needs a groups list`);
      continue;
    }
    for (const group of /** @type {Group[]} */ (doc['groups'])) {
      if (typeof group.name !== 'string' || groupNames.has(group.name)) {
        problems.push(`${file}: every group needs a name unique across the rule files`);
      }
      groupNames.add(group.name);
      for (const rule of group.rules ?? []) {
        if (rule.record !== undefined) {
          problems.push(`${file}: recording rules belong in ${PATHS.recording}/`);
          continue;
        }
        const alert = checkAlert({
          file,
          service,
          nonprod,
          rule,
          slos,
          known,
          dashboards,
          problems,
        });
        if (alert) alerts.push(alert);
      }
    }
  }

  // Across all alerts.
  const names = new Set(alerts.map((a) => a.name));
  for (const required of REQUIRED_ALERTS) {
    if (!names.has(required)) problems.push(`the alert ${required} is missing`);
  }
  const variants = new Set();
  for (const alert of alerts) {
    const key = `${alert.name}/${alert.severity}`;
    if (variants.has(key)) {
      problems.push(
        `${alert.file}: ${alert.name} has two ${alert.severity} rules; merge them with or`,
      );
    }
    variants.add(key);
  }
  const pageAlerts = [...new Set(alerts.filter((a) => a.severity === 'page').map((a) => a.name))];
  if (pageAlerts.length > MAX_PAGE_ALERTS) {
    problems.push(
      `${pageAlerts.length} alerts page (${pageAlerts.join(', ')}); at most ${MAX_PAGE_ALERTS} may`,
    );
  }

  // Runbooks: one per alert, each complete; the template too.
  const runbookFiles = readdirSync(join(root, PATHS.runbooks)).filter((f) => f.endsWith('.md'));
  for (const file of runbookFiles) {
    const name = file.replace(/\.md$/, '');
    const path = `${PATHS.runbooks}/${file}`;
    const text = readFileSync(join(root, path), 'utf8');
    if (file === '_template.md') {
      const sections = markdownSections(text);
      for (const section of RUNBOOK_SECTIONS) {
        if (!sections.has(section)) problems.push(`${path}: no "## ${section}" section`);
      }
    } else if (!names.has(name)) {
      problems.push(`${path}: no alert is named ${name}`);
    } else {
      problems.push(...runbookProblems(path, text));
    }
    problems.push(...brokenLinks(root, path, text));
  }
  if (!runbookFiles.includes('_template.md')) problems.push(`${PATHS.template} is missing`);
  for (const name of [...names].sort()) {
    if (!runbookFiles.includes(`${name}.md`)) {
      problems.push(`${PATHS.runbooks}/${name}.md is missing: every alert needs a runbook`);
    }
  }
  for (const doc of PATHS.docs) {
    if (!existsSync(join(root, doc))) problems.push(`${doc} is missing`);
    else problems.push(...brokenLinks(root, doc, readFileSync(join(root, doc), 'utf8')));
  }

  return {
    problems,
    alerts,
    pageAlerts,
    runbooks: runbookFiles.filter((f) => f !== '_template.md'),
  };
}

/**
 * Checks one alerting rule, adding to `problems`; returns it typed, or undefined when unusable.
 * @param {{ file: string, service: string, nonprod: boolean, rule: Rule, slos: Set<string>,
 *   known: Set<string>, dashboards: Set<string | undefined>, problems: string[] }} input
 * @returns {AlertRule | undefined}
 */
function checkAlert({ file, service, nonprod, rule, slos, known, dashboards, problems }) {
  const name = rule.alert;
  if (typeof name !== 'string' || !ALERT_NAME.test(name)) {
    problems.push(`${file}: an alert name must be UpperCamelCase (got ${String(name)})`);
    return undefined;
  }
  const at = `${file}: ${name}`;
  const expr = typeof rule.expr === 'string' ? rule.expr : '';
  if (expr.trim() === '') problems.push(`${at}: no expr`);
  if (rule.for !== undefined && !(typeof rule.for === 'string' && DURATION.test(rule.for))) {
    problems.push(`${at}: for must be a duration such as 15m`);
  }

  /** @type {Record<string, string>} */
  const labels = {};
  for (const [key, value] of Object.entries(isRecord(rule.labels) ? rule.labels : {})) {
    if (![...REQUIRED_LABELS, ...OPTIONAL_LABELS].includes(key)) {
      problems.push(`${at}: the label ${key} is not allowed (${REQUIRED_LABELS.join(', ')}, slo)`);
    }
    if (FORBIDDEN_LABEL.test(key)) problems.push(`${at}: the label ${key} could hold an id`);
    if (typeof value !== 'string' || value === '' || value.includes('{{')) {
      problems.push(`${at}: the label ${key} must be a fixed, non-empty string`);
    } else {
      labels[key] = value;
    }
  }
  for (const key of REQUIRED_LABELS) {
    if (labels[key] === undefined) problems.push(`${at}: the label ${key} is required`);
  }
  const severity = labels['severity'] ?? '';
  if (labels['severity'] !== undefined && !SEVERITIES.includes(severity)) {
    problems.push(`${at}: severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (labels['service'] !== undefined && labels['service'] !== service) {
    problems.push(`${at}: service ${labels['service']} belongs in ${labels['service']}.rules.yaml`);
  }
  if (labels['owner'] !== undefined && !OWNER.test(labels['owner'])) {
    problems.push(`${at}: owner must be a team name in lower case`);
  }
  const runbook = `${PATHS.runbooks}/${name}.md`;
  if (labels['runbook'] !== undefined && labels['runbook'] !== runbook) {
    problems.push(`${at}: runbook must be ${runbook}`);
  }
  if (labels['slo'] !== undefined && !slos.has(labels['slo'])) {
    problems.push(`${at}: slo ${labels['slo']} is not one of B093's SLOs`);
  }

  /** @type {Record<string, string>} */
  const annotations = {};
  for (const [key, value] of Object.entries(isRecord(rule.annotations) ? rule.annotations : {})) {
    if (![...REQUIRED_ANNOTATIONS, ...OPTIONAL_ANNOTATIONS].includes(key)) {
      problems.push(`${at}: the annotation ${key} is not allowed`);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${at}: the annotation ${key} must be non-empty text`);
      continue;
    }
    annotations[key] = value;
    for (const match of value.matchAll(TEMPLATE)) {
      const label = TEMPLATE_LABEL.exec(/** @type {string} */ (match[1]))?.[1];
      if (label === undefined || !TEMPLATE_LABELS.includes(label)) {
        problems.push(
          `${at}: ${key} may only show {{ $labels.<${TEMPLATE_LABELS.join('|')}> }} (got ${match[0]})`,
        );
      }
    }
    if (CUSTOMER_DATA.test(value.replace(TEMPLATE, ''))) {
      problems.push(`${at}: ${key} holds an id or an e-mail address`);
    }
  }
  for (const key of REQUIRED_ANNOTATIONS) {
    if (annotations[key] === undefined) problems.push(`${at}: the annotation ${key} is required`);
  }
  const dashboard = annotations['dashboard'];
  if (dashboard !== undefined) {
    const uid = DASHBOARD.exec(dashboard.replace(TEMPLATE, 'x'))?.[1];
    if (uid === undefined || !dashboards.has(uid)) {
      problems.push(`${at}: dashboard must be /d/<uid>?… of a dashboard in ${PATHS.dashboards}/`);
    }
  }
  if (
    severity === 'page' &&
    labels['slo'] === undefined &&
    annotations['user_impact'] === undefined
  ) {
    problems.push(`${at}: a page needs an slo label or a user_impact annotation`);
  }

  const pending = annotations['pending_metric'];
  if (pending !== undefined) {
    if (!nonprod) problems.push(`${at}: pending_metric is allowed in non-prod rule files only`);
    if (!/^B\d{3}$/.test(pending)) problems.push(`${at}: pending_metric names a lane (B###)`);
  }
  const unknown = metricNames(expr).filter((m) => !known.has(m));
  if (unknown.length > 0 && pending === undefined) {
    problems.push(
      `${at}: reads ${unknown.join(', ')}, not in B093's catalogue, a recording rule or exporters.yaml`,
    );
  }
  if (unknown.length === 0 && pending !== undefined) {
    problems.push(`${at}: every metric it reads exists; drop pending_metric`);
  }

  return {
    file,
    service,
    nonprod,
    name,
    severity,
    labels,
    annotations,
    expr,
    for: typeof rule.for === 'string' ? rule.for : undefined,
  };
}

/**
 * The CLI; returns the exit code.
 * @param {{ write?: (text: string) => void, error?: (text: string) => void, root?: string }} [io]
 * @returns {number}
 */
export function main(io = {}) {
  const write = io.write ?? ((text) => void process.stdout.write(text));
  const error = io.error ?? ((text) => void process.stderr.write(text));
  const result = lintAlerts(io.root === undefined ? {} : { root: io.root });
  if (result.problems.length > 0) {
    error(`alerts:lint found ${result.problems.length} problem(s):\n`);
    for (const problem of result.problems) error(`- ${problem}\n`);
    return 1;
  }
  const names = new Set(result.alerts.map((a) => a.name));
  write(
    `alerts:lint: ${names.size} alerts (${result.pageAlerts.length} page) in ` +
      `${new Set(result.alerts.map((a) => a.file)).size} rule files, ` +
      `${result.runbooks.length} runbooks: ok\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
