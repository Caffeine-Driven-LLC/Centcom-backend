/**
 * `pnpm alerts:lint` (B094): it passes on the repository, and each broken fixture fails it with the
 * problem named: a missing runbook and an unknown metric (committed fixtures), and in-place breaks
 * of labels, annotations, files, runbooks, links and the page budget.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogueSeries,
  hasCommandOrDashboard,
  lintAlerts,
  main,
  markdownSections,
  MAX_PAGE_ALERTS,
  metricNames,
  numberedItems,
  REQUIRED_ALERTS,
  runbookProblems,
} from '../lint.mjs';
import { copyAlertingFiles, REPO } from './helpers.js';

const FIXTURES = join(REPO, 'infra/alerts/test/fixtures');

describe('the repository', () => {
  it('passes the lint, with all 18 named alerts, at most 10 paging', () => {
    const result = lintAlerts();
    expect(result.problems).toEqual([]);
    const names = new Set(result.alerts.map((a) => a.name));
    for (const name of REQUIRED_ALERTS) expect(names.has(name), name).toBe(true);
    expect(REQUIRED_ALERTS).toHaveLength(18);
    expect(result.pageAlerts.length).toBeLessThanOrEqual(MAX_PAGE_ALERTS);
  });

  it('main prints a summary and exits 0', () => {
    let out = '';
    expect(main({ write: (t) => void (out += t), error: () => undefined })).toBe(0);
    expect(out).toMatch(
      /^alerts:lint: \d+ alerts \(\d+ page\) in \d+ rule files, \d+ runbooks: ok\n$/,
    );
  });
});

describe('metricNames', () => {
  it('finds selected metrics and skips functions, keywords, labels, strings and durations', () => {
    expect(
      metricNames(
        'max by (env, queue) (centcom_queue_depth{queue=~".+[.](dlq|dead)"}) > 0 ' +
          'and on (env) rate(centcom_http_requests_total{route!~"/healthz"}[5m] offset 1h) ' +
          'or round(slo:burn_rate:1h{slo="x"}, 0.001) >= 14.4 unless absent(up) ' +
          'or 1e3 * time() - 14 * 86400 > bool Inf',
      ),
    ).toEqual(['centcom_http_requests_total', 'centcom_queue_depth', 'slo:burn_rate:1h', 'up']);
  });

  it('does not mistake a prefix of a function name for a metric', () => {
    expect(metricNames('rate(x[5m])')).toEqual(['x']);
    expect(metricNames('sum without (instance) (y) / ignoring (state) z')).toEqual(['y', 'z']);
  });

  it('reads histogram series from the catalogue', () => {
    const series = catalogueSeries();
    expect(series.has('centcom_http_request_duration_seconds_bucket')).toBe(true);
    expect(series.has('centcom_http_requests_total')).toBe(true);
    expect(series.has('centcom_http_requests_total_bucket')).toBe(false);
  });
});

describe('runbook checks', () => {
  const sections = (triage: string, verification = 'Run `x`.') =>
    [
      '# A',
      '## Symptoms',
      's',
      '## Impact',
      'i',
      '## Dashboards',
      'd',
      '## Triage commands',
      triage,
      '## Mitigation',
      'm',
      '## Escalation',
      'e',
      '## Verification',
      verification,
      '## Post-incident',
      'p',
    ].join('\n');

  it('accepts commands, fenced blocks and dashboard links in every step', () => {
    expect(
      runbookProblems(
        'r.md',
        sections(
          '1. Run `a`.\n2. Look at `$GRAFANA/d/centcom-api-overview`.\n3. Then:\n   ```\n   b\n   ```',
        ),
      ),
    ).toEqual([]);
  });

  it('names the step without a command, a missing section and an empty one', () => {
    expect(runbookProblems('r.md', sections('1. Run `a`.\n2. Think hard.'))).toEqual([
      'r.md: triage step 2 has no command or dashboard link',
    ]);
    expect(runbookProblems('r.md', sections('Just look around.'))).toEqual([
      'r.md: triage commands must be a numbered list',
    ]);
    expect(runbookProblems('r.md', sections('1. `a`', 'It recovers.'))).toEqual([
      'r.md: verification needs a command or dashboard link to check recovery',
    ]);
    expect(runbookProblems('r.md', '# A\n## Symptoms\n\n## Impact\nx')).toContain(
      'r.md: "## Symptoms" is empty',
    );
    expect(runbookProblems('r.md', '')).toEqual(['r.md: empty']);
  });

  it('ignores headings inside fenced code', () => {
    expect([...markdownSections('## A\n```\n## B\n```\n## C\nc').keys()]).toEqual(['A', 'C']);
    expect(numberedItems('1. a\n   more\n2. b')).toEqual(['1. a\n   more', '2. b']);
    expect(hasCommandOrDashboard('see /d/centcom-relay-overview')).toBe(true);
  });
});

describe('broken fixtures', () => {
  let cleanup = (): void => undefined;
  afterEach(() => cleanup());

  /** A copy of the alerting files, changed by `change`, linted. */
  function lintWith(change: (root: string) => void): string[] {
    const copy = copyAlertingFiles();
    cleanup = copy.cleanup;
    change(copy.root);
    return lintAlerts({ root: copy.root }).problems;
  }
  const rules = (root: string, file: string) => join(root, 'infra/alerts/rules', file);
  const edit = (path: string, from: string | RegExp, to: string) => {
    const text = readFileSync(path, 'utf8');
    const next = text.replace(from, to);
    if (next === text) throw new Error(`nothing to replace in ${path}`);
    writeFileSync(path, next);
  };

  it('an alert without its runbook file', () => {
    const problems = lintWith((root) =>
      copyFileSync(join(FIXTURES, 'missing-runbook.rules.yaml'), rules(root, 'fixture.rules.yaml')),
    );
    expect(problems).toEqual([
      'infra/runbooks/alerts/FixtureMissingRunbook.md is missing: every alert needs a runbook',
    ]);
  });

  it('an alert reading a metric that is not catalogued', () => {
    const problems = lintWith((root) => {
      copyFileSync(join(FIXTURES, 'unknown-metric.rules.yaml'), rules(root, 'fixture.rules.yaml'));
      copyFileSync(
        join(root, 'infra/runbooks/alerts/RelayOverloaded.md'),
        join(root, 'infra/runbooks/alerts/FixtureUnknownMetric.md'),
      );
    });
    expect(problems).toEqual([
      "infra/alerts/rules/fixture.rules.yaml: FixtureUnknownMetric: reads centcom_no_such_thing_total, not in B093's catalogue, a recording rule or exporters.yaml",
    ]);
  });

  it('a pending metric in a prod file, and one that is not pending at all', () => {
    const problems = lintWith((root) => {
      edit(
        rules(root, 'redis.rules.yaml'),
        "dashboard: '/d/",
        "pending_metric: 'B099'\n          dashboard: '/d/",
      );
    });
    expect(problems).toContain(
      'infra/alerts/rules/redis.rules.yaml: RedisMemoryHigh: pending_metric is allowed in non-prod rule files only',
    );
    expect(problems).toContain(
      'infra/alerts/rules/redis.rules.yaml: RedisMemoryHigh: every metric it reads exists; drop pending_metric',
    );
  });

  it('missing and invalid labels', () => {
    const problems = lintWith((root) => {
      edit(rules(root, 'redis.rules.yaml'), '          owner: platform\n', '');
      edit(rules(root, 'redis.rules.yaml'), 'severity: ticket', 'severity: urgent');
      edit(
        rules(root, 'postgres.rules.yaml'),
        'service: postgres\n          owner: platform\n          runbook: infra/runbooks/alerts/PostgresReplicationLag.md',
        'service: redis\n          owner: platform\n          user_id: x\n          runbook: infra/runbooks/PostgresReplicationLag.md',
      );
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'infra/alerts/rules/redis.rules.yaml: RedisMemoryHigh: the label owner is required',
        'infra/alerts/rules/redis.rules.yaml: RedisMemoryHigh: severity must be one of page, ticket, info',
        'infra/alerts/rules/postgres.rules.yaml: PostgresReplicationLag: service redis belongs in redis.rules.yaml',
        'infra/alerts/rules/postgres.rules.yaml: PostgresReplicationLag: the label user_id could hold an id',
        'infra/alerts/rules/postgres.rules.yaml: PostgresReplicationLag: runbook must be infra/runbooks/alerts/PostgresReplicationLag.md',
      ]),
    );
  });

  it('annotations with customer data, an unknown label, no dashboard or a foreign one', () => {
    const problems = lintWith((root) => {
      const file = rules(root, 'redis.rules.yaml');
      edit(
        file,
        "summary: 'Redis in {{ $labels.env }}",
        "summary: 'Redis of {{ $labels.workspace_id }} in {{ $labels.env }}",
      );
      edit(file, "impact: 'At the limit", "impact: 'Ask alice@example.com. At the limit");
      edit(
        rules(root, 'postgres.rules.yaml'),
        /dashboard: '\/d\/centcom-database-redis\?var-env=\{\{ \$labels\.env \}\}'\n\n/,
        '\n',
      );
      edit(
        rules(root, 'platform.rules.yaml'),
        "dashboard: '/d/centcom-api-overview?var-env={{ $labels.env }}'",
        "dashboard: '/d/someone-elses?var-env=x'",
      );
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'infra/alerts/rules/redis.rules.yaml: RedisMemoryHigh: summary may only show {{ $labels.<env|region|queue|component|job> }} (got {{ $labels.workspace_id }})',
        'infra/alerts/rules/redis.rules.yaml: RedisMemoryHigh: impact holds an id or an e-mail address',
        'infra/alerts/rules/postgres.rules.yaml: PostgresReplicationLag: the annotation dashboard is required',
        'infra/alerts/rules/platform.rules.yaml: CertExpirySoon: dashboard must be /d/<uid>?… of a dashboard in infra/observability/dashboards/',
      ]),
    );
  });

  it('a page without an SLO or a user-impact statement, and more than 10 pages', () => {
    const problems = lintWith((root) => {
      edit(rules(root, 'redis.rules.yaml'), 'severity: ticket', 'severity: page');
    });
    expect(problems).toContain(
      'infra/alerts/rules/redis.rules.yaml: RedisMemoryHigh: a page needs an slo label or a user_impact annotation',
    );
    expect(problems.some((p) => /^11 alerts page \(.*\); at most 10 may$/.test(p))).toBe(true);
  });

  it('a missing named alert, a split service, a badly named file, two rules of one severity', () => {
    const problems = lintWith((root) => {
      rmSync(rules(root, 'redis.rules.yaml'));
      rmSync(rules(root, 'redis.test.yaml'));
      rmSync(join(root, 'infra/runbooks/alerts/RedisMemoryHigh.md'));
      copyFileSync(rules(root, 'postgres.rules.yaml'), rules(root, 'postgres.nonprod.rules.yaml'));
      writeFileSync(rules(root, 'Notes.yaml'), 'groups: []\n');
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'the alert RedisMemoryHigh is missing',
        "infra/alerts/rules/postgres.rules.yaml: postgres's thresholds are already in infra/alerts/rules/postgres.nonprod.rules.yaml; keep one file per service",
        'infra/alerts/rules/Notes.yaml: rule files are <service>.rules.yaml or <service>.nonprod.rules.yaml',
        'infra/alerts/rules/postgres.rules.yaml: PostgresReplicationLag has two ticket rules; merge them with or',
        'infra/alerts/rules/postgres.rules.yaml: every group needs a name unique across the rule files',
      ]),
    );
  });

  it('an incomplete runbook, an orphan runbook and a broken link', () => {
    const problems = lintWith((root) => {
      const runbooks = join(root, 'infra/runbooks/alerts');
      edit(
        join(runbooks, 'CertExpirySoon.md'),
        /## Escalation[\s\S]*?## Verification/,
        '## Verification',
      );
      edit(
        join(runbooks, 'ReadyzFailing.md'),
        '4. Is a deploy draining them: `fly releases -a centcom-$ENV-<component>`.',
        '4. Ask around.',
      );
      copyFileSync(join(runbooks, 'CertExpirySoon.md'), join(runbooks, 'NoSuchAlert.md'));
      edit(join(root, 'docs/ops/oncall.md'), '(observability.md)', '(no-such-file.md)');
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'infra/runbooks/alerts/CertExpirySoon.md: no "## Escalation" section',
        'infra/runbooks/alerts/ReadyzFailing.md: triage step 4 has no command or dashboard link',
        'infra/runbooks/alerts/NoSuchAlert.md: no alert is named NoSuchAlert',
        'docs/ops/oncall.md: the link to no-such-file.md does not resolve',
      ]),
    );
  });

  it('out-of-date 30m SLO windows', () => {
    const problems = lintWith((root) => {
      edit(
        join(root, 'infra/observability/slo/api-latency.slo.yaml'),
        'objective: 0.95',
        'objective: 0.96',
      );
    });
    expect(problems).toContain(
      'infra/alerts/recording/slo-30m.rules.yaml is out of date: run node infra/alerts/slo-windows.mjs',
    );
  });

  it('main lists the problems and exits 1', () => {
    const copy = copyAlertingFiles();
    cleanup = copy.cleanup;
    copyFileSync(
      join(FIXTURES, 'missing-runbook.rules.yaml'),
      rules(copy.root, 'fixture.rules.yaml'),
    );
    let err = '';
    expect(main({ root: copy.root, write: () => undefined, error: (t) => void (err += t) })).toBe(
      1,
    );
    expect(err).toContain(
      'alerts:lint found 1 problem(s):\n- infra/runbooks/alerts/FixtureMissingRunbook.md',
    );
  });
});
