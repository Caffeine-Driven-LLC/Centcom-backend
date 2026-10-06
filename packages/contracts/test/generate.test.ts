/**
 * The generator (B003 acceptance 7 and 8, guardrails and failure modes): committed output is
 * current, stale output is detected, unsupported input fails loudly, and validators are standalone.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTRACTS_DIR, DEFAULT_OUT_DIR, diffOutput, generate, GenerateError, writeOutput } from '../scripts/generate.js';

const PACKAGE_DIR = join(import.meta.dirname, '..');
const TIMEOUT = 60_000;
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

/** A minimal contracts/ tree: one schema, a state map, no openapi.yaml or errors.json. */
function miniContracts(): string {
  const dir = tempDir('contracts-');
  mkdirSync(join(dir, 'schemas'));
  const machine = ['openapi.yaml', 'errors.json', 'state-map.json', 'schemas/*.json', 'fixtures/**'];
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ contract_version: '9.9.9', files: { machine } }));
  cpSync(join(DEFAULT_CONTRACTS_DIR, 'schemas', 'problem.schema.json'), join(dir, 'schemas', 'problem.schema.json'));
  writeFileSync(join(dir, 'state-map.json'), JSON.stringify({ idle: 'idle_breathe' }));
  return dir;
}

type Obj = Record<string, unknown>;
function editJson(path: string, edit: (doc: Obj) => void): void {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Obj;
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
}
const editProblem = (dir: string, edit: (doc: Obj) => void) => editJson(join(dir, 'schemas', 'problem.schema.json'), edit);
const props = (doc: Obj) => doc.properties as Record<string, Obj>;

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/generate.ts', ...args], {
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
}

describe('committed output', () => {
  it('src/generated/ is identical to a fresh run (what `pnpm contracts:check` enforces)', { timeout: TIMEOUT }, () => {
    const { files, warnings } = generate();
    // The one known contract gap (see the queue.reject test in validate.test.ts).
    expect(warnings).toEqual([expect.stringMatching(/queue\.reject is a clear kind .*\(contract gap\)$/)]);
    expect(diffOutput(files, DEFAULT_OUT_DIR)).toEqual([]);
    for (const [name, content] of files) {
      expect(content.startsWith('// GENERATED FILE - DO NOT EDIT.'), name).toBe(true);
      expect(content.includes('\r'), `${name} has CR characters`).toBe(false);
    }
  });
});

describe('standalone validators (acceptance 8)', () => {
  const code = readFileSync(join(DEFAULT_OUT_DIR, 'validators.js'), 'utf8');

  it('contain no eval or new Function and load only Ajv runtime helpers', () => {
    expect(code).not.toMatch(/\bnew Function\b/);
    expect(code).not.toMatch(/\beval\s*\(/);
    const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const r of required) expect(r).toMatch(/^(ajv\/dist\/runtime\/[a-z0-9_]+|ajv-formats\/dist\/formats)$/);
    const imports = [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:module']);
  });

  it('map validators by short names that secret scanners cannot mistake for credentials', () => {
    const map = code.slice(code.indexOf('export const VALIDATORS = Object.freeze({'));
    const entries = [...map.matchAll(/^ {2}"([^"]+)": (\w+),$/gm)];
    expect(entries.length).toBeGreaterThan(200);
    for (const [line, , ident] of entries) expect(ident, line).toMatch(/^v\d{1,4}$/);
  });

  it('run with runtime code generation disabled (--disallow-code-generation-from-strings)', { timeout: TIMEOUT }, () => {
    const url = pathToFileURL(join(DEFAULT_OUT_DIR, 'validators.js')).href;
    const fixtures = pathToFileURL(join(DEFAULT_CONTRACTS_DIR, 'fixtures', 'events')).href;
    const script = `
      import { readdirSync, readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      const { VALIDATORS } = await import(${JSON.stringify(url)});
      const dir = fileURLToPath(${JSON.stringify(fixtures)});
      let valid = 0;
      for (const f of readdirSync(dir)) {
        const fx = JSON.parse(readFileSync(dir + '/' + f, 'utf8'));
        if (VALIDATORS.envelope(fx.frame) && VALIDATORS.events(fx.frame)) valid++;
      }
      VALIDATORS['api/Me']({});
      console.log('valid frames: ' + valid);
      // Canary (constant string, no input): proves the flag is active, so it must throw here.
      eval('1');`;
    const r = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: TIMEOUT,
    });
    // Every validator ran without code generation; only the deliberate eval at the end failed.
    expect(r.stdout).toContain('valid frames: 45');
    expect(r.stderr).toMatch(/EvalError: Code generation from strings disallowed/);
    expect(r.stderr).toMatch(/eval\('1'\)/);
  });
});

describe('stale output (acceptance 7)', () => {
  it('diffOutput reports files that change when a schema changes', () => {
    const contracts = miniContracts();
    const out = tempDir('generated-');
    writeOutput(generate(contracts).files, out);
    expect(diffOutput(generate(contracts).files, out)).toEqual([]);
    editProblem(contracts, (doc) => {
      props(doc).hint = { type: 'string' };
    });
    expect(diffOutput(generate(contracts).files, out)).toEqual(['types.ts: stale', 'validators.js: stale']);
  });

  it('`--check` exits 1 when a schema is edited without regenerating, 0 after regenerating', { timeout: TIMEOUT }, () => {
    const contracts = miniContracts();
    const out = tempDir('generated-');
    const check = () => cli('--check', '--contracts', contracts, '--out', out);
    const gen = () => cli('--contracts', contracts, '--out', out);

    expect(check().status).toBe(1); // nothing generated yet
    expect(gen().status).toBe(0);
    const ok = check();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('up to date');

    editProblem(contracts, (doc) => {
      props(doc).hint = { type: 'string' };
    });
    const stale = check();
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('out of date');
    expect(stale.stderr).toContain('types.ts: stale');

    expect(gen().status).toBe(0);
    expect(check().status).toBe(0);
  });

  it('reports and removes files that are no longer generated', () => {
    const contracts = miniContracts();
    const out = tempDir('generated-');
    const { files } = generate(contracts);
    writeOutput(files, out);
    writeFileSync(join(out, 'old.ts'), 'export {};\n');
    expect(diffOutput(files, out)).toEqual(['old.ts: no longer generated']);
    writeOutput(files, out);
    expect(existsSync(join(out, 'old.ts'))).toBe(false);
  });
});

describe('failure modes', () => {
  const failsWith = (dir: string, message: RegExp) => {
    expect(() => generate(dir)).toThrow(GenerateError);
    expect(() => generate(dir)).toThrow(message);
  };

  it('an unsupported keyword fails with the file, keyword and location', () => {
    const contracts = miniContracts();
    editProblem(contracts, (doc) => {
      props(doc).status = { ...props(doc).status, unevaluatedProperties: false };
    });
    failsWith(contracts, /contracts\/schemas\/problem\.schema\.json: unsupported JSON Schema keyword "unevaluatedProperties" at \/properties\/status/);
  });

  it('an unsupported format fails', () => {
    const contracts = miniContracts();
    editProblem(contracts, (doc) => {
      props(doc).instance = { type: 'string', format: 'ipv4' };
    });
    failsWith(contracts, /unsupported format "ipv4" at \/properties\/instance/);
  });

  it('a schema that is not 2020-12 or has no $id fails', () => {
    const a = miniContracts();
    editProblem(a, (doc) => {
      doc.$schema = 'http://json-schema.org/draft-07/schema#';
    });
    failsWith(a, /problem\.schema\.json: \$schema must be/);
    const b = miniContracts();
    editProblem(b, (doc) => {
      delete doc.$id;
    });
    failsWith(b, /problem\.schema\.json: \$id is missing/);
  });

  it('a required machine file listed in index.json but missing fails', () => {
    const contracts = miniContracts();
    rmSync(join(contracts, 'state-map.json'));
    failsWith(contracts, /contracts\/state-map\.json is listed in contracts\/index\.json but missing/);
  });

  it('no schemas fails', () => {
    const contracts = miniContracts();
    rmSync(join(contracts, 'schemas'), { recursive: true });
    failsWith(contracts, /contracts\/schemas\/ holds no \*\.schema\.json files/);
  });

  it('openapi.yaml and errors.json are skipped with a loud warning while absent', () => {
    const { files, warnings } = generate(miniContracts());
    expect(warnings).toEqual([
      'WARNING: contracts/openapi.yaml is listed in contracts/index.json but missing; skipped until present',
      'WARNING: contracts/errors.json is listed in contracts/index.json but missing; skipped until present',
      'contracts/CONTRACTS.lock is missing; CONTRACTS_LOCK_SHA256 is null',
    ]);
    expect(files.get('errors.ts')).toContain('export const ERRORS = {} as const;');
    expect(files.get('meta.ts')).toContain('export const CONTRACT_VERSION = "9.9.9";');
  });

  it('an event kind with an unrecognised payload rule fails', () => {
    const contracts = miniContracts();
    cpSync(join(DEFAULT_CONTRACTS_DIR, 'schemas', 'events.schema.json'), join(contracts, 'schemas', 'events.schema.json'));
    editJson(join(contracts, 'schemas', 'events.schema.json'), (doc) => {
      const rule = (doc.allOf as Obj[])[0] as { then: Obj };
      delete rule.then.not;
    });
    failsWith(contracts, /kind message\.user has an unrecognised payload rule/);
  });

  it('the CLI exits 1 and names the problem', { timeout: TIMEOUT }, () => {
    const contracts = miniContracts();
    editProblem(contracts, (doc) => {
      doc.prefixItems = [];
    });
    const r = cli('--check', '--contracts', contracts, '--out', tempDir('generated-'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unsupported JSON Schema keyword "prefixItems"');
  });
});
