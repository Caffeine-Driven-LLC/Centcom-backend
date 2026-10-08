/**
 * The small scripts beside the rules (B094): the 30m SLO windows generator and the promtool
 * runner's file lists.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMETHEUS_IMAGE as TESTKIT_PROMETHEUS_IMAGE } from '@centcom/testkit';
import { parse } from 'yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PROMETHEUS_IMAGE, promtoolRuns, ruleFiles, testFiles } from '../promtool.mjs';
import { readSlos, run, sloWindowRules, WINDOWS_FILE } from '../slo-windows.mjs';
import { REPO } from './helpers.js';

describe('slo-windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b094-windows-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('records the 30m error ratio and burn rate of every SLO, as B093 records its windows', () => {
    const slos = readSlos();
    const doc = parse(sloWindowRules(slos)) as {
      groups: {
        name: string;
        rules: { record: string; expr: string; labels: { slo: string } }[];
      }[];
    };
    expect(doc.groups.map((g) => g.name)).toEqual(slos.map((s) => `slo-windows-${s.name}`));
    const b093 = parse(
      readFileSync(join(REPO, 'infra/observability/slo/rules.yaml'), 'utf8'),
    ) as typeof doc;
    for (const group of doc.groups) {
      expect(group.rules.map((r) => r.record)).toEqual([
        'slo:sli_error:ratio_rate30m',
        'slo:burn_rate:30m',
      ]);
      // The same expressions as B093's 1h window, over 30m.
      const slo = group.name.replace('slo-windows-', '');
      const ref = b093.groups.find((g) => g.name === `slo-${slo}`)?.rules ?? [];
      const oneHour = (record: string) => ref.find((r) => r.record === record)?.expr ?? '';
      expect(group.rules[0]?.expr).toBe(
        oneHour('slo:sli_error:ratio_rate1h').replaceAll('[1h]', '[30m]'),
      );
      expect(group.rules[1]?.expr).toBe(
        oneHour('slo:burn_rate:1h').replace('ratio_rate1h', 'ratio_rate30m'),
      );
    }
  });

  it('is up to date, and --check fails on a stale file', () => {
    expect(run({ check: true })).toBe(0);
    cpSync(join(REPO, 'infra/observability/slo'), join(dir, 'infra/observability/slo'), {
      recursive: true,
    });
    cpSync(join(REPO, 'infra/alerts/recording'), join(dir, 'infra/alerts/recording'), {
      recursive: true,
    });
    writeFileSync(join(dir, WINDOWS_FILE), 'groups: []\n');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(run({ root: dir, check: true })).toBe(1);
    } finally {
      stderr.mockRestore();
    }
    expect(run({ root: dir })).toBe(0);
    expect(readFileSync(join(dir, WINDOWS_FILE), 'utf8')).toBe(
      readFileSync(join(REPO, WINDOWS_FILE), 'utf8'),
    );
  });
});

describe('promtool runner', () => {
  it('checks B093 rules, the windows and every rule file, and runs every test file', () => {
    expect(ruleFiles()).toEqual([
      'infra/observability/slo/rules.yaml',
      'infra/alerts/recording/slo-30m.rules.yaml',
      'infra/alerts/rules/api.rules.yaml',
      'infra/alerts/rules/backup.nonprod.rules.yaml',
      'infra/alerts/rules/platform.rules.yaml',
      'infra/alerts/rules/postgres.rules.yaml',
      'infra/alerts/rules/redis.rules.yaml',
      'infra/alerts/rules/relay.rules.yaml',
      'infra/alerts/rules/retention.nonprod.rules.yaml',
      'infra/alerts/rules/worker.rules.yaml',
    ]);
    expect(testFiles()).toHaveLength(8);
    expect(promtoolRuns()).toEqual([
      ['check', 'rules', ...ruleFiles()],
      ['test', 'rules', ...testFiles()],
    ]);
  });

  it('uses the same Prometheus image as the container tests', () => {
    expect(PROMETHEUS_IMAGE).toBe(TESTKIT_PROMETHEUS_IMAGE);
  });
});
