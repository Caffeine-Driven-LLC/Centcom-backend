/**
 * Contract fixture runner (B010): loads contracts/fixtures/** and contracts/schemas/*.json and
 * checks every fixture against its schema with Ajv (JSON Schema 2020-12) directly, so a lane that
 * implements a contract proves its fixtures in its own tests with one call. Two fixture shapes:
 * `{schema, valid, data}` (data must validate exactly when `valid`) and event fixtures
 * `{kind, frame, secret_payload}` (the frame, and the secret payload where the schema defines one,
 * must validate).
 *
 * Owns: loading schemas and fixtures and judging them. Must not: change a fixture, or pass one it
 * cannot judge (an unknown shape or a missing definition fails).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { it } from 'vitest';

// ajv-formats is CommonJS: its function is the module's `default` property (as in B003's generator).
const addFormats = addFormatsModule.default;

/** Options for `runFixtureSuite`. */
export interface FixtureSuiteOptions {
  /** A directory of fixture files, such as contracts/fixtures/events. */
  fixturesDir: string;
  /** The schema to validate against, such as contracts/schemas/events.schema.json. */
  schemaFile: string;
  /**
   * Validate against `$defs[defKey(fixtureName)]` of the schema instead of the whole schema: the
   * fixture's `data`, or an event fixture's cleartext payload (`frame.p`).
   */
  defKey?: (fixtureName: string) => string;
  /** Registers one case per fixture; default vitest's `it`. */
  register?: (name: string, check: () => void) => void;
}

/** The verdict on one fixture. */
export interface FixtureResult {
  ok: boolean;
  /** Why it failed, with the schema errors; empty when it passed. */
  message: string;
}

type Json = Record<string, unknown>;
type Validate = ((value: unknown) => boolean) & { errors?: unknown[] | null };

/** One Ajv instance per schemas directory, holding every schema in it (they reference each other). */
const ajvs = new Map<string, Ajv2020>();

function ajvFor(schemasDir: string): Ajv2020 {
  let ajv = ajvs.get(schemasDir);
  if (ajv === undefined) {
    ajv = new Ajv2020({
      strict: true,
      strictTypes: false,
      strictRequired: false,
      allowUnionTypes: true,
      allErrors: false,
      discriminator: true,
    });
    addFormats(ajv);
    for (const file of readdirSync(schemasDir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, file), 'utf8')) as Json);
    }
    ajvs.set(schemasDir, ajv);
  }
  return ajv;
}

const schemaId = (schemaFile: string): string => {
  const id = (JSON.parse(readFileSync(schemaFile, 'utf8')) as Json)['$id'];
  if (typeof id !== 'string') throw new Error(`${schemaFile} has no $id`);
  return id;
};

/** The validator for the whole schema or one of its $defs; undefined when the definition is missing. */
function validatorFor(schemaFile: string, def?: string): Validate | undefined {
  const ajv = ajvFor(dirname(schemaFile));
  const id = schemaId(schemaFile);
  return ajv.getSchema(def === undefined ? id : `${id}#/$defs/${def}`) as Validate | undefined;
}

const describeErrors = (validate: Validate): string => JSON.stringify(validate.errors ?? []);

/** The `$defs` key of an event kind's secret payload: `message.user` → `s_message_user`. */
const secretDef = (kind: string): string => `s_${kind.replace(/\./g, '_')}`;

/** Judges one fixture file. Pure: reads files, changes nothing. */
export function checkFixture(
  file: string,
  opts: Omit<FixtureSuiteOptions, 'register' | 'fixturesDir'>,
): FixtureResult {
  const name = basename(file);
  let fixture: Json;
  try {
    fixture = JSON.parse(readFileSync(file, 'utf8')) as Json;
  } catch (err) {
    return { ok: false, message: `${name} is not readable JSON: ${(err as Error).message}` };
  }
  const def = opts.defKey?.(name);
  const validate = validatorFor(opts.schemaFile, def);
  if (validate === undefined) {
    return {
      ok: false,
      message: `${basename(opts.schemaFile)} has no $defs/${def ?? ''} for ${name}`,
    };
  }

  if (
    typeof fixture['kind'] === 'string' &&
    typeof fixture['frame'] === 'object' &&
    fixture['frame'] !== null
  ) {
    const frame = fixture['frame'] as Json;
    const target = def === undefined ? frame : frame['p'];
    if (!validate(target))
      return {
        ok: false,
        message: `${name}: the event does not validate: ${describeErrors(validate)}`,
      };
    const secret = fixture['secret_payload'];
    if (secret !== null && secret !== undefined) {
      const validateSecret = validatorFor(opts.schemaFile, secretDef(fixture['kind']));
      if (validateSecret !== undefined && !validateSecret(secret)) {
        return {
          ok: false,
          message: `${name}: the secret payload does not validate: ${describeErrors(validateSecret)}`,
        };
      }
    }
    return { ok: true, message: '' };
  }

  if (typeof fixture['valid'] === 'boolean' && 'data' in fixture) {
    if (typeof fixture['schema'] === 'string' && fixture['schema'] !== basename(opts.schemaFile)) {
      return {
        ok: false,
        message: `${name} is a fixture for ${fixture['schema']}, not ${basename(opts.schemaFile)}`,
      };
    }
    const valid = validate(fixture['data']);
    if (valid === fixture['valid']) return { ok: true, message: '' };
    return {
      ok: false,
      message: valid
        ? `${name} should be rejected (${String(fixture['note'] ?? 'no note')}), but it validates`
        : `${name} should validate, but: ${describeErrors(validate)}`,
    };
  }

  return {
    ok: false,
    message: `${name} is neither a {schema, valid, data} nor a {kind, frame} fixture`,
  };
}

/**
 * Registers one test per `*.json` file in `fixturesDir` (sorted by name) that checks it against
 * `schemaFile`; a fixture that does not get the verdict it declares fails its test.
 */
export function runFixtureSuite(opts: FixtureSuiteOptions): void {
  const register = opts.register ?? ((name: string, check: () => void) => it(name, check));
  const files = readdirSync(opts.fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of files) {
    register(file, () => {
      const result = checkFixture(join(opts.fixturesDir, file), opts);
      if (!result.ok) throw new Error(result.message);
    });
  }
}
