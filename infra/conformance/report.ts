/**
 * The conformance report (B100): its shape, a structural validator, and the exit-code rule.
 *
 * Owns: the report vocabulary. Must not: run anything.
 */

export type CaseStatus = 'pass' | 'fail' | 'skip';

export interface CaseReport {
  name: string;
  fixture: string | null;
  status: CaseStatus;
  duration_ms: number;
  error: { message: string; pointer: string | null } | null;
}

export interface ContractReport {
  id: string;
  status: 'pass' | 'fail' | 'missing_fixtures' | 'not_run';
  fixtures_run: number;
  /** Test files that were run for this contract. */
  tests: string[];
  cases: CaseReport[];
}

export interface GateCheck {
  name: string;
  status: 'pass' | 'fail';
  detail: string | null;
}

export interface GateReport {
  id: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
  status: 'pass' | 'fail' | 'not_run';
  checks: GateCheck[];
}

export interface ConformanceReport {
  schema_version: 1;
  generated_at: string;
  git_sha: string;
  contract_version: string;
  contracts_lock_hash: string;
  target: { kind: 'local' | 'stage'; base_url: string };
  duration_ms: number;
  summary: {
    contracts_total: number;
    contracts_passed: number;
    contracts_failed: number;
    cases_total: number;
    passed: number;
    failed: number;
    skipped: number;
    missing_fixtures: number;
  };
  contracts: ContractReport[];
  gates: GateReport[];
}

/** Problems with `report` as a conformance report; empty when it is well formed. */
export function reportProblems(report: unknown): string[] {
  const problems: string[] = [];
  const r = report as Partial<ConformanceReport> | null;
  if (typeof r !== 'object' || r === null) return ['not an object'];
  if (r.schema_version !== 1) problems.push('schema_version must be 1');
  for (const key of [
    'generated_at',
    'git_sha',
    'contract_version',
    'contracts_lock_hash',
  ] as const) {
    if (typeof r[key] !== 'string' || r[key] === '')
      problems.push(`${key} must be a non-empty string`);
  }
  if (typeof r.duration_ms !== 'number') problems.push('duration_ms must be a number');
  if (r.target?.kind !== 'local' && r.target?.kind !== 'stage') problems.push('target.kind');
  const s = r.summary;
  if (s === undefined) problems.push('summary missing');
  const contracts = r.contracts;
  if (!Array.isArray(contracts)) problems.push('contracts must be an array');
  else {
    let cases = 0;
    let failed = 0;
    let passed = 0;
    let skipped = 0;
    for (const c of contracts) {
      if (!['pass', 'fail', 'missing_fixtures', 'not_run'].includes(c.status))
        problems.push(`${c.id}: status`);
      for (const k of c.cases) {
        cases += 1;
        if (k.status === 'fail') failed += 1;
        else if (k.status === 'pass') passed += 1;
        else skipped += 1;
        if (k.status === 'fail' && k.error === null)
          problems.push(`${c.id}: failed case "${k.name}" has no error`);
      }
    }
    if (s !== undefined) {
      if (s.contracts_total !== contracts.length)
        problems.push('summary.contracts_total does not match');
      if (s.cases_total !== cases) problems.push('summary.cases_total does not match');
      if (s.failed !== failed || s.passed !== passed || s.skipped !== skipped)
        problems.push('summary counts do not match');
    }
  }
  if (!Array.isArray(r.gates)) problems.push('gates must be an array');
  return problems;
}

/** Computes the summary from the contracts. */
export function summarize(contracts: ContractReport[]): ConformanceReport['summary'] {
  const cases = contracts.flatMap((c) => c.cases);
  return {
    contracts_total: contracts.length,
    contracts_passed: contracts.filter((c) => c.status === 'pass').length,
    contracts_failed: contracts.filter((c) => c.status === 'fail').length,
    cases_total: cases.length,
    passed: cases.filter((c) => c.status === 'pass').length,
    failed: cases.filter((c) => c.status === 'fail').length,
    skipped: cases.filter((c) => c.status === 'skip').length,
    missing_fixtures: contracts.filter((c) => c.status === 'missing_fixtures').length,
  };
}

/** 0 all pass, 1 any failure, 3 `--strict` with a contract whose fixtures are missing or that did not run. */
export function exitCode(report: ConformanceReport, strict: boolean): number {
  if (report.summary.failed > 0 || report.summary.contracts_failed > 0) return 1;
  if (report.gates.some((g) => g.status === 'fail')) return 1;
  if (
    strict &&
    report.contracts.some((c) => c.status === 'missing_fixtures' || c.status === 'not_run')
  )
    return 3;
  return 0;
}
