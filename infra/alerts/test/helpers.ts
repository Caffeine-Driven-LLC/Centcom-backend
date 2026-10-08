/**
 * Shared helpers for the alerting tests (B094): the rule files as data, annotation expansion as
 * Prometheus does it for `{{ $labels.x }}`, Alertmanager's route matching, and a throwaway copy of
 * the repository's alerting files for the lint's broken fixtures.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** The repository root. */
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const RULES_DIR = join(REPO, 'infra/alerts/rules');

/** One alerting rule, with the file it is in. */
export interface AlertRuleDoc {
  file: string;
  alert: string;
  expr: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** Every alerting rule under infra/alerts/rules/. */
export function readAlertRules(): AlertRuleDoc[] {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.rules.yaml'))
    .sort()
    .flatMap((file) => {
      const doc = parse(readFileSync(join(RULES_DIR, file), 'utf8')) as {
        groups: { rules: Omit<AlertRuleDoc, 'file'>[] }[];
      };
      return doc.groups.flatMap((g) => g.rules.map((r) => ({ ...r, file })));
    });
}

/** `text` with each `{{ $labels.x }}` replaced by `labels.x`, as Prometheus expands it. */
export function expandAnnotation(text: string, labels: Readonly<Record<string, string>>): string {
  return text.replace(
    /\{\{\s*\$labels\.([a-z_]+)\s*\}\}/g,
    (_, name: string) => labels[name] ?? '',
  );
}

/** A promtool unit test file. */
export interface PromtoolTestFile {
  rule_files: string[];
  tests: {
    input_series: { series: string; values: string }[];
    alert_rule_test?: {
      eval_time: string;
      alertname: string;
      exp_alerts: { exp_labels: Record<string, string>; exp_annotations: Record<string, string> }[];
    }[];
  }[];
}

/** Every promtool test file under infra/alerts/rules/, by file name. */
export function readPromtoolTests(): Map<string, PromtoolTestFile> {
  return new Map(
    readdirSync(RULES_DIR)
      .filter((f) => f.endsWith('.test.yaml'))
      .sort()
      .map((f) => [f, parse(readFileSync(join(RULES_DIR, f), 'utf8')) as PromtoolTestFile]),
  );
}

/** Minutes in a Prometheus duration such as `26m`, `6h` or `3d` (single unit). */
export function minutes(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration);
  if (!match) throw new Error(`not a duration: ${duration}`);
  const n = Number(match[1]);
  const unit = match[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  return n * { ms: 1 / 60_000, s: 1 / 60, m: 1, h: 60, d: 1440 }[unit];
}

/** An Alertmanager route as written in alertmanager.yml. */
export interface Route {
  receiver?: string;
  matchers?: string[];
  continue?: boolean;
  group_by?: string[];
  group_wait?: string;
  group_interval?: string;
  repeat_interval?: string;
  routes?: Route[];
}

/** Where a label set is routed: one entry per matching leaf, with inherited timings. */
export interface Routed {
  receiver: string;
  group_by: string[];
  group_wait: string;
  group_interval: string;
  repeat_interval: string;
}

/** A matcher (`a="b"`, `a!="b"`, `a=~"re"`, `a!~"re"`) as a predicate, regexes anchored. */
export function matcher(text: string): (labels: Readonly<Record<string, string>>) => boolean {
  const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"(.*)"$/.exec(text.trim());
  if (!match) throw new Error(`not a matcher: ${text}`);
  const [, name, op, value] = match as unknown as [string, string, string, string];
  const re = new RegExp(`^(?:${value})$`);
  return (labels) => {
    const v = labels[name] ?? '';
    if (op === '=') return v === value;
    if (op === '!=') return v !== value;
    if (op === '=~') return re.test(v);
    return !re.test(v);
  };
}

/** Alertmanager's tree walk (dispatch.Route.Match): every leaf `labels` reaches. */
export function route(
  root: Route,
  labels: Readonly<Record<string, string>>,
  inherited?: Omit<Routed, 'receiver'>,
): Routed[] {
  const here: Routed = {
    receiver: root.receiver ?? '',
    group_by: root.group_by ?? inherited?.group_by ?? [],
    group_wait: root.group_wait ?? inherited?.group_wait ?? '30s',
    group_interval: root.group_interval ?? inherited?.group_interval ?? '5m',
    repeat_interval: root.repeat_interval ?? inherited?.repeat_interval ?? '4h',
  };
  if (inherited !== undefined && !(root.matchers ?? []).every((m) => matcher(m)(labels))) return [];
  const matched: Routed[] = [];
  for (const child of root.routes ?? []) {
    const leaves = route({ receiver: here.receiver, ...child }, labels, here);
    matched.push(...leaves);
    if (leaves.length > 0 && child.continue !== true) break;
  }
  return matched.length > 0 ? matched : [here];
}

/** A throwaway copy of the files the lint reads; `cleanup()` removes it. */
export function copyAlertingFiles(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'b094-alerts-'));
  for (const dir of ['infra/alerts', 'infra/runbooks', 'infra/observability', 'docs/ops']) {
    cpSync(join(REPO, dir), join(root, dir), {
      recursive: true,
      filter: (src) => !src.includes(`${join('infra', 'alerts', 'test')}`),
    });
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
