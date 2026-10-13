/**
 * WAF module policy tests (B097) over real offline `terraform plan` output (tests/fixtures, made by
 * tests/gen-plan.mjs with dummy values): managed ruleset on, the CT-PAGE rate limits, HTTPS only,
 * blocked methods, and the rule order that keeps health checks and the relay's WebSocket path
 * reachable. A stale fixture (the .tf files changed without regenerating) fails the first test.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = import.meta.dirname;
const read = (path: string) => readFileSync(join(DIR, path), 'utf8');

interface Rule {
  ref: string;
  expression: string;
  action: string;
  enabled: boolean;
  action_parameters?: { id?: string; ruleset?: string };
  ratelimit?: {
    characteristics: string[];
    period: number;
    requests_per_period: number;
    mitigation_timeout: number;
  };
}
interface Plan {
  mode: string;
  resources: { address: string; values: { phase: string; kind: string; rules: Rule[] } }[];
}

const plan = (mode: string): Plan => JSON.parse(read(`tests/fixtures/plan-${mode}.json`)) as Plan;
const ruleset = (p: Plan, name: string) => {
  const found = p.resources.find((r) => r.address === `module.waf.cloudflare_ruleset.${name}`);
  if (found === undefined) throw new Error(`no ${name} ruleset in the plan`);
  return found.values;
};
const rule = (p: Plan, name: string, ref: string): Rule => {
  const found = ruleset(p, name).rules.find((r) => r.ref === ref);
  if (found === undefined) throw new Error(`no rule ${ref} in ${name}`);
  return found;
};

describe('the plan fixtures', () => {
  it('match the module files (regenerate with tests/gen-plan.mjs after a change)', () => {
    const files = [
      ...readdirSync(DIR)
        .filter((f) => f.endsWith('.tf'))
        .map((f) => join(DIR, f)),
      join(DIR, 'tests', 'plan', 'main.tf'),
    ].sort();
    const hash = createHash('sha256');
    for (const f of files) hash.update(readFileSync(f));
    expect(hash.digest('hex')).toBe(read('tests/fixtures/module.sha256').trim());
  });

  it('plan three zone rulesets in the phases the card names', () => {
    const p = plan('block');
    expect(
      p.resources.map((r) => [r.address.split('.').pop(), r.values.phase, r.values.kind]),
    ).toEqual([
      ['custom', 'http_request_firewall_custom', 'zone'],
      ['managed', 'http_request_firewall_managed', 'zone'],
      ['rate_limit', 'http_ratelimit', 'zone'],
    ]);
  });
});

describe('policy', () => {
  const p = plan('block');

  it('executes the managed ruleset(s) on our hosts, enabled', () => {
    const managed = rule(p, 'managed', 'managed_cloudflare_free');
    expect(managed).toMatchObject({ action: 'execute', enabled: true });
    expect(managed.action_parameters?.id).toBe('77454fe2d30c4220b5701f6fdfb893ba');
    expect(managed.expression).toContain('"api.example.com"');
    expect(managed.expression).toContain('"relay.example.com"');
  });

  it('limits auth endpoints to 20 and anonymous requests to 30 a minute per address', () => {
    const auth = rule(p, 'rate_limit', 'auth_endpoints');
    const anon = rule(p, 'rate_limit', 'anonymous');
    expect(auth.ratelimit).toMatchObject({ requests_per_period: 20, period: 60 });
    expect(anon.ratelimit).toMatchObject({ requests_per_period: 30, period: 60 });
    expect(auth.ratelimit?.characteristics).toContain('ip.src');
    expect(anon.ratelimit?.characteristics).toContain('ip.src');
    expect(auth.expression).toContain('starts_with(http.request.uri.path, "/v1/auth/")');
    expect(anon.expression).toContain('len(http.request.headers["authorization"]) eq 0');
    expect(auth.action).toBe('block');
  });

  it('denies plain HTTP except certificate validation, and the unused methods', () => {
    const https = rule(p, 'custom', 'https_only');
    expect(https.action).toBe('block');
    expect(https.expression).toContain('not ssl');
    expect(https.expression).toContain('/.well-known/acme-challenge/');
    const methods = rule(p, 'custom', 'blocked_methods');
    expect(methods.expression).toContain('"TRACE" "TRACK" "CONNECT"');
  });

  it('starts the custom and managed rulesets with the availability skip, so no later rule can block health checks', () => {
    for (const name of ['custom', 'managed']) {
      const first = ruleset(p, name).rules[0];
      expect(first?.ref, name).toBe('availability_skip');
      expect(first?.action).toBe('skip');
      expect(first?.action_parameters?.ruleset).toBe('current');
      for (const path of ['/healthz', '/readyz', '/v1/status'])
        expect(first?.expression).toContain(`"${path}"`);
    }
    for (const ref of ['auth_endpoints', 'anonymous']) {
      expect(rule(p, 'rate_limit', ref).expression, ref).toContain(
        'not http.request.uri.path in {"/healthz" "/readyz" "/v1/status"}',
      );
    }
  });

  it('lets the relay host serve only the WebSocket path (after the skip, so health checks still pass)', () => {
    const rules = ruleset(p, 'custom').rules;
    const skip = rules.findIndex((r) => r.ref === 'availability_skip');
    const relay = rules.findIndex((r) => r.ref === 'relay_paths');
    expect(skip).toBeLessThan(relay);
    const expression = rules[relay]?.expression ?? '';
    expect(expression).toContain('http.host in {"relay.example.com"}');
    expect(expression).toContain('not http.request.uri.path in {"/v1/ws"}');
    // the WebSocket path itself is never in a blocking expression
    for (const r of rules.filter((x) => x.action === 'block' && x.ref !== 'relay_paths')) {
      expect(r.expression, r.ref).not.toContain('/v1/ws');
    }
  });
});

describe('modes', () => {
  it('log mode records instead of blocking, and off disables every refusing rule', () => {
    const log = plan('log');
    expect(rule(log, 'custom', 'https_only').action).toBe('log');
    expect(rule(log, 'rate_limit', 'auth_endpoints').action).toBe('log');
    expect(rule(log, 'custom', 'availability_skip').enabled).toBe(true);
    const off = plan('off');
    for (const name of ['custom', 'managed', 'rate_limit']) {
      for (const r of ruleset(off, name).rules.filter((x) => x.ref !== 'availability_skip')) {
        expect(r.enabled, `${name}.${r.ref}`).toBe(false);
      }
    }
  });
});
