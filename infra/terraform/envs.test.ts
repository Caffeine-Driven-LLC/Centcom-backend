/**
 * Policy tests for the infrastructure as code (B091), over the offline `terraform plan` of each
 * environment root (tests/fixtures, made by tests/gen-plan.mjs with placeholder tokens) and over the
 * generated Fly files in infra/fly. No Docker, no account: the plans are committed. A stale fixture
 * (the .tf or tfvars files changed without regenerating) fails the first test.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SERVICES, SERVICE_TABLE, readVars, renderAll } from '../fly/gen.mjs';
import { decide } from './run.mjs';
import { inputsHash } from './tests/gen-plan.mjs';

const TF = import.meta.dirname;
const FLY = join(TF, '..', 'fly');
const ENVS = ['dev', 'stage', 'prod'] as const;
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8').replaceAll('\r\n', '\n');

interface Resource {
  address: string;
  type: string;
  name: string;
  values: Record<string, unknown>;
}
interface Plan {
  env: string;
  resources: Resource[];
  outputs: Record<string, unknown>;
}
const plan = (env: string): Plan =>
  JSON.parse(read(TF, 'tests', 'fixtures', `plan-${env}.json`)) as Plan;
const ofType = (p: Plan, type: string) => p.resources.filter((r) => r.type === type);
const toml = (service: string, env: string) => read(FLY, `fly.${service}.${env}.toml`);

/** Every file under a directory, skipping Terraform's working directory. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '.terraform') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('the plan fixtures', () => {
  it('match the Terraform files and tfvars (regenerate with tests/gen-plan.mjs after a change)', () => {
    expect(inputsHash()).toBe(read(TF, 'tests', 'fixtures', 'inputs.sha256').trim());
  });

  it('plan every resource as a create, with no unknown naming', () => {
    for (const env of ENVS) {
      const p = plan(env);
      expect(p.resources.length).toBeGreaterThan(30);
      for (const r of p.resources) {
        const named = [r.values.name, r.values.app, r.values.bucket_name].filter(
          (v): v is string => typeof v === 'string',
        );
        for (const n of named)
          expect(n, `${env} ${r.address}`).toMatch(
            /^centcom-|^[a-z0-9.-]+\.centcom\.example$|^(pg|redis)_data$|^retain-|^abort-|^expire-/,
          );
      }
    }
  });
});

describe('prod topology (acceptance 3)', () => {
  const p = plan('prod');
  const scale = p.outputs.scale as Record<
    string,
    { regions: string[]; count?: number; count_per_region?: number; ha?: boolean }
  >;

  it('runs the api in at least 2 regions with at least 3 machines', () => {
    expect(new Set(scale.api?.regions).size).toBeGreaterThanOrEqual(2);
    expect(scale.api?.count).toBeGreaterThanOrEqual(3);
  });

  it('runs the relay in at least 2 regions with at least 2 machines in each', () => {
    expect(new Set(scale.relay?.regions).size).toBeGreaterThanOrEqual(2);
    expect(scale.relay?.count_per_region).toBeGreaterThanOrEqual(2);
  });

  it('runs at least 2 workers', () => {
    expect(scale.worker?.count).toBeGreaterThanOrEqual(2);
  });

  it('has Postgres with a replica in another region, each machine on its own volume', () => {
    const machines = ofType(p, 'fly_machine').filter((m) => m.address.includes('module.postgres'));
    const volumes = ofType(p, 'fly_volume').filter((v) => v.address.includes('module.postgres'));
    expect(scale.postgres?.ha).toBe(true);
    expect(new Set(machines.map((m) => m.values.region)).size).toBeGreaterThanOrEqual(2);
    expect(volumes).toHaveLength(machines.length);
    expect(String(machines[0]?.values.image)).toMatch(/^flyio\/postgres-flex:16\.\d+$/);
  });

  it('has Redis with the append-only file on a volume', () => {
    const redis = ofType(p, 'fly_machine').find((m) => m.address.includes('module.redis'));
    expect(String((redis?.values.entrypoint as string[]).join(' '))).toContain('--appendonly yes');
    expect(redis?.values.mounts).toHaveLength(1);
  });

  it('has five private R2 buckets: the public address is off and nothing else exposes them', () => {
    const buckets = ofType(p, 'cloudflare_r2_bucket');
    expect(buckets.map((b) => b.values.name).sort()).toEqual(
      ['backups', 'exports', 'history', 'releases', 'snapshots'].map((n) => `centcom-prod-${n}`),
    );
    const managed = ofType(p, 'cloudflare_r2_managed_domain');
    expect(managed).toHaveLength(buckets.length);
    for (const m of managed) expect(m.values.enabled).toBe(false);
    expect(ofType(p, 'cloudflare_r2_custom_domain')).toHaveLength(0);
    expect(ofType(p, 'cloudflare_r2_bucket_lifecycle')).toHaveLength(buckets.length);
  });

  it('locks backups against deletion for 30 days', () => {
    const [lock] = ofType(p, 'cloudflare_r2_bucket_lock');
    expect(ofType(p, 'cloudflare_r2_bucket_lock')).toHaveLength(1);
    expect(lock?.values.bucket_name).toBe('centcom-prod-backups');
    expect(
      (lock?.values.rules as { condition: { max_age_seconds: number } }[])[0]?.condition
        .max_age_seconds,
    ).toBeGreaterThanOrEqual(30 * 86400);
  });
});

describe('the other environments', () => {
  it('dev is one small machine per service', () => {
    const sizes = readVars('dev').machine_sizes;
    for (const s of ['api', 'worker', 'admin']) expect(sizes[s].count).toBe(1);
    expect(sizes.relay.count_per_region).toBe(1);
    for (const s of Object.values(sizes) as { cpus: number; memory_mb: number }[]) {
      expect(s.cpus).toBe(1);
      expect(s.memory_mb).toBeLessThanOrEqual(512);
    }
    expect(readVars('dev').postgres_ha).toBe(false);
  });

  it('stage has the topology of prod at a smaller size', () => {
    const stage = readVars('stage');
    const prod = readVars('prod');
    expect(stage.regions_api).toEqual(prod.regions_api);
    expect(stage.regions_relay).toEqual(prod.regions_relay);
    expect(stage.postgres_ha).toBe(true);
    for (const s of ['api', 'worker']) {
      expect(stage.machine_sizes[s].count).toBeLessThanOrEqual(prod.machine_sizes[s].count);
      expect(stage.machine_sizes[s].memory_mb).toBeLessThanOrEqual(prod.machine_sizes[s].memory_mb);
    }
  });

  it('the scale each plan outputs is the scale in its tfvars', () => {
    for (const env of ENVS) {
      const v = readVars(env);
      const scale = plan(env).outputs.scale as Record<
        string,
        { regions: string[]; count?: number }
      >;
      expect(scale.api).toEqual({ regions: v.regions_api, count: v.machine_sizes.api.count });
      expect(scale.relay?.regions).toEqual(v.regions_relay);
    }
  });
});

describe('Fly files (acceptance 5)', () => {
  it('are exactly what infra/fly/gen.mjs renders (run it after changing a tfvars file)', () => {
    for (const [name, text] of renderAll()) expect(read(FLY, name), name).toBe(text);
    const onDisk = readdirSync(FLY).filter((f) => f.endsWith('.toml'));
    expect(onDisk.sort()).toEqual([...renderAll().keys()].sort());
  });

  it('give every service /healthz and /readyz HTTP checks on its own port', () => {
    for (const env of ENVS) {
      for (const service of SERVICES) {
        const text = toml(service, env);
        const port = (SERVICE_TABLE as Record<string, { port: number }>)[service]?.port;
        expect(text, `${service} ${env}`).toMatch(
          /\[checks\.healthz\][^[]*type = "http"[^[]*path = "\/healthz"/,
        );
        expect(text, `${service} ${env}`).toMatch(
          /\[checks\.readyz\][^[]*type = "http"[^[]*path = "\/readyz"/,
        );
        expect(text).toContain(`port = ${port}`);
      }
    }
  });

  it('give the relay a kill_timeout of at least 60 s, in every environment', () => {
    for (const env of ENVS) {
      const seconds = Number(/kill_timeout = "(\d+)s"/.exec(toml('relay', env))?.[1]);
      expect(seconds).toBeGreaterThanOrEqual(60);
    }
  });

  it('keep the admin app private: no listener and no public address, host name or certificate', () => {
    for (const env of ENVS) {
      const text = toml('admin', env);
      expect(text).not.toMatch(/\[http_service\]|\[\[services\]\]/);
      const p = plan(env);
      const adminApp = `centcom-${env}-admin`;
      const mine = p.resources.filter((r) => r.values.app === adminApp);
      expect(mine.map((r) => r.type)).toEqual([]);
      expect(JSON.stringify(p.outputs.relay_urls) + String(p.outputs.api_url)).not.toContain(
        'admin',
      );
      expect(
        p.resources.filter((r) => r.name === 'cname' && String(r.values.name).includes('admin')),
      ).toEqual([]);
    }
  });

  it('serve the api and relay over HTTPS only', () => {
    for (const env of ENVS) {
      for (const service of ['api', 'relay']) {
        expect(toml(service, env)).toContain('force_https = true');
      }
    }
  });
});

describe('environments share nothing (acceptance 6)', () => {
  const identifiers = (env: string) =>
    plan(env)
      .resources.flatMap((r) =>
        [
          r.values.name,
          r.values.app,
          r.values.bucket_name,
          r.values.hostname,
          r.values.content,
        ].map(String),
      )
      .filter((v) => v !== 'undefined' && v !== 'null');

  it('has no resource name, bucket, host name or target in common between two environments', () => {
    for (const [a, b] of [
      ['dev', 'stage'],
      ['dev', 'prod'],
      ['stage', 'prod'],
    ] as const) {
      const shared = identifiers(a).filter((v) => identifiers(b).includes(v));
      // Names that are the same word in every environment (volume labels) are not identifiers.
      expect(
        shared.filter(
          (v) =>
            !/^(pg_data|redis_data|abort-stale-uploads|expire-objects|retain-30-days|CNAME)$/.test(
              v,
            ),
        ),
      ).toEqual([]);
    }
  });

  it('keeps one state key, one state bucket and one Fly organisation per environment', () => {
    const keys = ENVS.map(
      (e) => /key\s*=\s*"([^"]+)"/.exec(read(TF, 'envs', e, 'versions.tf'))?.[1],
    );
    const buckets = ENVS.map(
      (e) => /bucket\s*=\s*"([^"]+)"/.exec(read(TF, 'envs', e, 'backend.hcl'))?.[1],
    );
    const orgs = ENVS.map((e) => readVars(e).fly_org);
    for (const list of [keys, buckets, orgs]) expect(new Set(list).size).toBe(3);
    ENVS.forEach((e, i) => {
      expect(keys[i]).toBe(`${e}/terraform.tfstate`);
      expect(buckets[i]).toBe(`centcom-${e}-tfstate`);
    });
  });

  it('has three roots that differ only in the environment name', () => {
    const norm = (env: string, file: string) => read(TF, 'envs', env, file).replaceAll(env, 'ENV');
    for (const file of ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf']) {
      expect(norm('stage', file), file).toBe(norm('dev', file));
      expect(norm('prod', file), file).toBe(norm('dev', file));
    }
  });
});

describe('secrets and pins (acceptance 4 and the guardrails)', () => {
  // The waf module is B097's (it pins "~> 5.0"); these rules are B091's modules and roots.
  const files = walk(TF).filter(
    (f) => !f.includes(join('tests', 'fixtures')) && !f.includes(join('modules', 'waf')),
  );
  const tf = files.filter((f) => f.endsWith('.tf'));

  it('commits no state, plan or credential file', () => {
    const all = [...walk(TF), ...walk(FLY)].map((f) => relative(join(TF, '..'), f));
    expect(
      all.filter((f) => /\.(tfstate|tfplan|pem|key)$|\.tfstate\.backup$|(^|\/)\.env/.test(f)),
    ).toEqual([]);
    expect(all.filter((f) => /\.tfvars$/.test(f))).toEqual([]);
  });

  it('keeps tfvars to non-secret settings', () => {
    const allowed = [
      'domain',
      'fly_org',
      'cloudflare_account_id',
      'cloudflare_zone_id',
      'region_primary',
      'regions_api',
      'regions_relay',
      'postgres_regions',
      'postgres_ha',
      'r2_location',
      'machine_sizes',
    ];
    for (const env of ENVS) expect(Object.keys(readVars(env)).sort()).toEqual([...allowed].sort());
  });

  it('declares no variable that could carry a credential unless it is sensitive', () => {
    for (const f of tf) {
      for (const m of read(f).matchAll(/variable "([^"]+)" \{([\s\S]*?)\n\}/g)) {
        if (/password|secret|token|api_key|private_key|credential/i.test(m[1] ?? '')) {
          expect(m[2], `${relative(TF, f)} ${m[1]}`).toMatch(/sensitive\s*=\s*true/);
        }
      }
    }
  });

  it('puts no token-shaped string in a Terraform, Fly or tfvars file', () => {
    const shape =
      /(fo1_|FlyV1 )[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/;
    for (const f of [
      ...tf,
      ...walk(FLY),
      ...ENVS.map((e) => join(TF, 'envs', e, 'terraform.tfvars.json')),
    ]) {
      expect(read(f), relative(TF, f)).not.toMatch(shape);
    }
  });

  it('pins every provider and image to an exact version', () => {
    for (const f of tf.filter((x) => x.endsWith('versions.tf'))) {
      for (const m of read(f).matchAll(/(?<![_a-z])version\s*=\s*"([^"]+)"/g)) {
        expect(m[1], relative(TF, f)).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
    for (const f of tf.filter((x) => x.endsWith('variables.tf'))) {
      for (const m of read(f).matchAll(/default\s*=\s*"([a-z/.-]+:[^"]+)"/g)) {
        expect(m[1], relative(TF, f)).not.toMatch(/:latest$|:\d+$/);
      }
    }
  });
});

describe('Fly secrets are documented', () => {
  const doc = read(FLY, 'SECRETS.md');
  const documented = new Set([...doc.matchAll(/^\| `([A-Z0-9_]+)`/gm)].map((m) => m[1]));

  it('lists every secret a fly.*.toml names, and the data layer passwords', () => {
    for (const env of ENVS) {
      for (const service of SERVICES) {
        const line = /Secrets this app reads .*?: (.*)$/m.exec(toml(service, env))?.[1] ?? '';
        const names = line.split(' ').filter(Boolean);
        expect(names.length, `${service} ${env}`).toBeGreaterThan(0);
        for (const n of names) expect(documented.has(n), `${service} ${env} ${n}`).toBe(true);
      }
    }
    for (const n of ['SU_PASSWORD', 'OPERATOR_PASSWORD', 'REPL_PASSWORD', 'REDIS_PASSWORD']) {
      expect(documented.has(n), n).toBe(true);
    }
  });

  it('names a secret the Terraform data layer reads only if it is documented', () => {
    const redis = read(TF, 'modules', 'redis', 'main.tf');
    for (const m of redis.matchAll(/\$([A-Z][A-Z0-9_]+)/g))
      expect(documented.has(m[1]), m[1]).toBe(true);
  });

  it('documents the secret names the plans output', () => {
    for (const env of ENVS) {
      const p = plan(env);
      expect(documented.has(p.outputs.database_url_secret_name as string)).toBe(true);
      expect(documented.has(p.outputs.redis_url_secret_name as string)).toBe(true);
    }
  });
});

describe('naming convention', () => {
  it('names every Fly app centcom-<env>-<service> and every bucket centcom-<env>-<purpose>', () => {
    for (const env of ENVS) {
      const p = plan(env);
      for (const app of ofType(p, 'fly_app')) {
        expect(String(app.values.name)).toMatch(
          new RegExp(`^centcom-${env}-(api|relay|worker|admin|db|redis)$`),
        );
      }
      for (const b of ofType(p, 'cloudflare_r2_bucket')) {
        expect(String(b.values.name)).toMatch(
          new RegExp(`^centcom-${env}-(history|snapshots|exports|releases|backups)$`),
        );
      }
      expect(Object.values(p.outputs.fly_app_names as Record<string, string>).sort()).toEqual(
        ofType(p, 'fly_app')
          .map((a) => String(a.values.name))
          .sort(),
      );
    }
  });

  it('serves the api at api.<domain> and the relay at relay-<region>.<domain>', () => {
    expect(plan('prod').outputs.api_url).toBe('https://api.centcom.example');
    expect(plan('stage').outputs.api_url).toBe('https://api.stage.centcom.example');
    expect(plan('dev').outputs.relay_urls).toEqual({ iad: 'wss://relay-iad.dev.centcom.example' });
  });
});

describe('pnpm infra:apply (guardrail: prod is never applied from a laptop)', () => {
  it('refuses prod outside CI and prod without a saved plan, and unknown environments', () => {
    expect(decide(['apply', 'prod', 'p.tfplan'], {})).toMatchObject({ ok: false });
    expect(decide(['apply', 'prod', 'p.tfplan'], { CI: 'false' })).toMatchObject({ ok: false });
    expect(decide(['apply', 'prod'], { CI: 'true' })).toMatchObject({ ok: false });
    expect(decide(['apply', 'qa'], { CI: 'true' })).toMatchObject({ ok: false });
    expect(decide(['destroy', 'dev'], {})).toMatchObject({ ok: false });
  });

  it('allows prod from CI with a plan file, dev and stage anywhere, and plan for every environment', () => {
    expect(decide(['apply', 'prod', 'p.tfplan'], { CI: 'true' })).toMatchObject({ ok: true });
    expect(decide(['apply', 'dev'], {})).toMatchObject({ ok: true, env: 'dev' });
    expect(decide(['apply', 'stage'], {})).toMatchObject({ ok: true, env: 'stage' });
    for (const env of ENVS) expect(decide(['plan', env], {})).toMatchObject({ ok: true });
  });
});
