/**
 * Contract code generator (lane B003).
 *
 * Reads contracts/ (index.json, schemas/*.json, openapi.yaml, errors.json, state-map.json) and writes
 * packages/contracts/src/generated/: TypeScript types, precompiled Ajv validators (strict and
 * tolerant), the event catalogue, the CT-ERR error registry, product states and contract metadata.
 *
 * Must not: edit contracts/, write partial output (everything is built in memory first and only
 * written when generation succeeded), or emit validators that compile schemas at runtime (Ajv
 * standalone code only; no eval or new Function).
 *
 * Usage: tsx scripts/generate.ts [--check] [--contracts <dir>] [--out <dir>]
 *   (default)  regenerate src/generated/
 *   --check    exit 1 if src/generated/ differs from a fresh run; nothing is written
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import standaloneModule from 'ajv/dist/standalone/index.js';
import addFormatsModule from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

// Both are CommonJS modules whose function is also their `default` export (NodeNext types the
// default import as the whole module).
const standaloneCode = standaloneModule.default;
const addFormats = addFormatsModule.default;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** contracts/ at the repository root. */
export const DEFAULT_CONTRACTS_DIR = resolve(PACKAGE_DIR, '..', '..', 'contracts');
/** Output directory; owned entirely by this generator. */
export const DEFAULT_OUT_DIR = join(PACKAGE_DIR, 'src', 'generated');

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const OPENAPI_ID = 'https://centcom.dev/contracts/openapi.json';
const OPENAPI_TOLERANT_ID = 'https://centcom.dev/contracts/tolerant/openapi.json';
const TOLERANT_BASE = 'https://centcom.dev/contracts/tolerant/';
/** An enum whose own description says this is extensible (CT-VER "documented as extensible"). */
const EXTENSIBLE_NOTE = /tolerate unknown values/i;
/** Machine files index.json may list that are skipped (with a warning) while absent. */
const OPTIONAL_MACHINE_FILES = new Set(['openapi.yaml', 'errors.json']);
/** Formats the generated validators implement (ajv-formats, full mode). */
const FORMATS = ['date', 'date-time', 'email', 'uri'];
/** Runtime modules generated validators may load; anything else fails generation. */
const ALLOWED_RUNTIME_REQUIRE = /^(ajv\/dist\/runtime\/[a-z0-9_]+|ajv-formats\/dist\/formats)$/;

const SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'discriminator',
]);
const MAP_KEYWORDS = new Set(['properties', '$defs']);
const SUBSCHEMA_KEYWORDS = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else']);
const LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf']);
/** Keywords that change the TypeScript shape of a value (the rest only constrain it). */
const SHAPE_KEYWORDS = [
  '$ref',
  'const',
  'enum',
  'type',
  'properties',
  'additionalProperties',
  'items',
  'oneOf',
  'anyOf',
  'allOf',
];

/** A generation failure; the message names the contract file and, where relevant, the keyword. */
export class GenerateError extends Error {
  override name = 'GenerateError';
}

/** Generated files keyed by file name, plus non-fatal warnings. */
export interface GenerateResult {
  files: Map<string, string>;
  warnings: string[];
}

interface SchemaFile {
  file: string;
  stem: string;
  id: string;
  typeName: string;
  schema: JsonObject;
}

type PayloadMode = 'encrypted' | 'hybrid' | 'clear';

interface EventKindInfo {
  kind: string;
  t: string;
  mode: PayloadMode;
  clearDef: string | null;
  secretDef: string | null;
  clearFields: string[];
}

interface Contracts {
  version: string;
  lockSha256: string | null;
  schemas: SchemaFile[];
  api: JsonObject | null;
  errors: JsonObject | null;
  stateMap: JsonObject;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const isObject = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pascal = (s: string): string =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

const pointerToken = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new GenerateError(`${label}: cannot read (${(e as Error).message})`);
  }
}

function readJson(path: string, label: string): Json {
  try {
    return JSON.parse(readText(path, label)) as Json;
  } catch (e) {
    if (e instanceof GenerateError) throw e;
    throw new GenerateError(`${label}: not valid JSON (${(e as Error).message})`);
  }
}

function asObject(v: Json | undefined, label: string): JsonObject {
  if (!isObject(v)) throw new GenerateError(`${label}: expected a JSON object`);
  return v;
}

function deepMap(node: Json, fn: (n: JsonObject) => JsonObject): Json {
  if (Array.isArray(node)) return node.map((n) => deepMap(n, fn));
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(fn(node))) out[k] = deepMap(v, fn);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Loading and checking contracts/

function checkSchema(node: Json, where: string, path: string): void {
  if (typeof node === 'boolean') return;
  if (!isObject(node)) throw new GenerateError(`${where}: schema at ${path || '/'} is not an object`);
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYWORDS.has(k)) {
      throw new GenerateError(
        `${where}: unsupported JSON Schema keyword "${k}" at ${path || '/'} (the generator and its validators only implement an explicit keyword list)`,
      );
    }
    if (k === 'format' && (typeof v !== 'string' || !FORMATS.includes(v))) {
      throw new GenerateError(`${where}: unsupported format ${JSON.stringify(v)} at ${path || '/'}`);
    }
    if (k === '$ref' && typeof v !== 'string') throw new GenerateError(`${where}: $ref at ${path} is not a string`);
    if (MAP_KEYWORDS.has(k)) {
      for (const [name, sub] of Object.entries(asObject(v, `${where} ${path}/${k}`))) {
        checkSchema(sub, where, `${path}/${k}/${pointerToken(name)}`);
      }
    } else if (SUBSCHEMA_KEYWORDS.has(k)) {
      checkSchema(v, where, `${path}/${k}`);
    } else if (LIST_KEYWORDS.has(k)) {
      if (!Array.isArray(v)) throw new GenerateError(`${where}: ${k} at ${path || '/'} is not an array`);
      v.forEach((sub, i) => checkSchema(sub, where, `${path}/${k}/${i}`));
    }
  }
}

function loadContracts(dir: string, warnings: string[]): Contracts {
  const index = asObject(readJson(join(dir, 'index.json'), 'contracts/index.json'), 'contracts/index.json');
  const version = index.contract_version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new GenerateError('contracts/index.json: contract_version is missing or not semver');
  }
  const files = isObject(index.files) ? index.files.machine : undefined;
  if (!Array.isArray(files)) throw new GenerateError('contracts/index.json: files.machine is missing');

  const present = new Set<string>();
  for (const entry of files) {
    if (typeof entry !== 'string') throw new GenerateError('contracts/index.json: files.machine holds a non-string');
    if (entry === 'schemas/*.json' || entry === 'fixtures/**') continue;
    if (entry.includes('*')) {
      warnings.push(`contracts/index.json lists "${entry}", which the generator does not read`);
    } else if (existsSync(join(dir, entry))) {
      present.add(entry);
    } else if (OPTIONAL_MACHINE_FILES.has(entry)) {
      warnings.push(`WARNING: contracts/${entry} is listed in contracts/index.json but missing; skipped until present`);
    } else {
      throw new GenerateError(`contracts/${entry} is listed in contracts/index.json but missing`);
    }
  }
  if (!files.includes('schemas/*.json')) throw new GenerateError('contracts/index.json does not list schemas/*.json');
  if (!files.includes('state-map.json') || !present.has('state-map.json')) {
    throw new GenerateError('contracts/state-map.json is required (CT-STATE-MAP)');
  }

  const schemaDir = join(dir, 'schemas');
  const schemaFiles = existsSync(schemaDir)
    ? readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json')).sort()
    : [];
  if (schemaFiles.length === 0) throw new GenerateError('contracts/schemas/ holds no *.schema.json files');

  const schemas = schemaFiles.map((file): SchemaFile => {
    const label = `contracts/schemas/${file}`;
    const schema = asObject(readJson(join(schemaDir, file), label), label);
    if (schema.$schema !== DIALECT) throw new GenerateError(`${label}: $schema must be ${DIALECT}`);
    if (typeof schema.$id !== 'string') throw new GenerateError(`${label}: $id is missing`);
    checkSchema(schema, label, '');
    const stem = file.slice(0, -'.schema.json'.length);
    return { file, stem, id: schema.$id, typeName: pascal(stem), schema };
  });

  let api: JsonObject | null = null;
  if (present.has('openapi.yaml')) {
    let doc: unknown;
    try {
      doc = parseYaml(readText(join(dir, 'openapi.yaml'), 'contracts/openapi.yaml'));
    } catch (e) {
      if (e instanceof GenerateError) throw e;
      throw new GenerateError(`contracts/openapi.yaml: not valid YAML (${(e as Error).message})`);
    }
    const openapi = asObject(doc as Json, 'contracts/openapi.yaml');
    if (typeof openapi.openapi !== 'string' || !openapi.openapi.startsWith('3.1')) {
      throw new GenerateError('contracts/openapi.yaml: only OpenAPI 3.1 (JSON Schema 2020-12) is supported');
    }
    const components = asObject(openapi.components, 'contracts/openapi.yaml components');
    const raw = asObject(components.schemas, 'contracts/openapi.yaml components.schemas');
    api = asObject(
      deepMap(raw, (n) => {
        if (typeof n.$ref !== 'string') return n;
        if (!n.$ref.startsWith('#/components/schemas/')) {
          throw new GenerateError(`contracts/openapi.yaml: unsupported $ref "${n.$ref}" in components.schemas`);
        }
        return { ...n, $ref: `#/$defs/${n.$ref.slice('#/components/schemas/'.length)}` };
      }),
      'contracts/openapi.yaml components.schemas',
    );
    for (const [name, s] of Object.entries(api)) {
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new GenerateError(`contracts/openapi.yaml: schema name "${name}" is not PascalCase`);
      checkSchema(s, 'contracts/openapi.yaml', `/components/schemas/${name}`);
    }
  }

  const errors = present.has('errors.json')
    ? asObject(readJson(join(dir, 'errors.json'), 'contracts/errors.json'), 'contracts/errors.json')
    : null;
  const stateMap = asObject(readJson(join(dir, 'state-map.json'), 'contracts/state-map.json'), 'contracts/state-map.json');
  const lockPath = join(dir, 'CONTRACTS.lock');
  const lockSha256 = existsSync(lockPath) ? sha256(readFileSync(lockPath)) : null;
  if (lockSha256 === null) warnings.push('contracts/CONTRACTS.lock is missing; CONTRACTS_LOCK_SHA256 is null');

  return { version, lockSha256, schemas, api, errors, stateMap };
}

// ---------------------------------------------------------------------------------------------
// The event catalogue (CT-WS-SESSION-EVENTS)

function readCatalogue(events: SchemaFile | undefined): EventKindInfo[] {
  if (!events) return [];
  const where = `contracts/schemas/${events.file}`;
  const defs = isObject(events.schema.$defs) ? events.schema.$defs : {};
  const rules = events.schema.allOf;
  if (!Array.isArray(rules)) throw new GenerateError(`${where}: expected a top-level allOf of kind rules`);
  const seen = new Set<string>();
  return rules.map((rule, i): EventKindInfo => {
    const ifProps = isObject(rule) && isObject(rule.if) && isObject(rule.if.properties) ? rule.if.properties : null;
    const kNode = ifProps?.k;
    const tNode = ifProps?.t;
    const then = isObject(rule) && isObject(rule.then) ? rule.then : null;
    if (!isObject(kNode) || typeof kNode.const !== 'string' || !isObject(tNode) || typeof tNode.const !== 'string' || !then) {
      throw new GenerateError(`${where}: allOf/${i} is not a {if: {k, t}, then} kind rule`);
    }
    const kind = kNode.const;
    if (seen.has(kind)) throw new GenerateError(`${where}: kind ${kind} appears twice`);
    seen.add(kind);
    const required = Array.isArray(then.required) ? then.required : [];
    const forbidden = isObject(then.not) && Array.isArray(then.not.required) ? then.not.required : [];
    let mode: PayloadMode;
    if (required.includes('ct') && required.includes('p')) mode = 'hybrid';
    else if (required.includes('ct') && forbidden.includes('p')) mode = 'encrypted';
    else if (required.includes('p') && forbidden.includes('ct')) mode = 'clear';
    else throw new GenerateError(`${where}: kind ${kind} has an unrecognised payload rule`);

    const suffix = kind.replace(/\./g, '_');
    let clearDef: string | null = null;
    if (mode !== 'encrypted') {
      const pRef = isObject(then.properties) && isObject(then.properties.p) ? then.properties.p.$ref : undefined;
      if (pRef !== `#/$defs/p_${suffix}`) {
        throw new GenerateError(`${where}: kind ${kind} must reference #/$defs/p_${suffix} for its cleartext payload`);
      }
      if (!isObject(defs[`p_${suffix}`])) throw new GenerateError(`${where}: $defs/p_${suffix} is missing`);
      clearDef = `p_${suffix}`;
    }
    const secretDef = isObject(defs[`s_${suffix}`]) ? `s_${suffix}` : null;
    const clearNode = clearDef ? defs[clearDef] : undefined;
    const clearFields = isObject(clearNode) && isObject(clearNode.properties) ? Object.keys(clearNode.properties) : [];
    return { kind, t: tNode.const, mode, clearDef, secretDef, clearFields };
  });
}

// ---------------------------------------------------------------------------------------------
// TypeScript types

const literal = (v: Json): string => {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return JSON.stringify(v);
  throw new GenerateError(`cannot express ${JSON.stringify(v)} as a TypeScript literal`);
};

const docComment = (text: string, indent: string): string => {
  const lines = text.replace(/\*\//g, '*\\/').split(/\r?\n/);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join('\n')}\n${indent} */\n`;
};

const propertyKey = (k: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

const affectsShape = (s: Json): boolean =>
  isObject(s) && SHAPE_KEYWORDS.some((k) => k in s && (k !== 'allOf' || (Array.isArray(s.allOf) && s.allOf.some(affectsShape))));

const isExtensibleEnum = (s: JsonObject): boolean =>
  Array.isArray(s.enum) && typeof s.description === 'string' && EXTENSIBLE_NOTE.test(s.description);

class TypeEmitter {
  constructor(
    private readonly where: string,
    private readonly resolveRef: (ref: string) => string,
  ) {}

  emit(schema: Json, indent: string): string {
    if (schema === true) return 'unknown';
    if (schema === false) return 'never';
    if (!isObject(schema)) throw new GenerateError(`${this.where}: schema is not an object`);
    const parts: string[] = [];
    const base = this.base(schema, indent);
    if (base !== null) parts.push(base);
    if (Array.isArray(schema.allOf)) {
      for (const member of schema.allOf) if (affectsShape(member)) parts.push(this.emit(member, indent));
    }
    if (parts.length === 0) return 'unknown';
    if (parts.length === 1) return parts[0] ?? 'unknown';
    return parts.map((p) => (/[|&]/.test(p) && !p.startsWith('{') ? `(${p})` : p)).join(' & ');
  }

  private base(s: JsonObject, indent: string): string | null {
    if (typeof s.$ref === 'string') return this.resolveRef(s.$ref);
    if ('const' in s) return literal(s.const ?? null);
    if (Array.isArray(s.enum)) return s.enum.map(literal).join(' | ');
    const union = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null;
    if (union) return union.map((m) => this.emit(m, indent)).join(' | ');
    if (typeof s.type === 'string') return this.forType(s.type, s, indent);
    if (Array.isArray(s.type)) {
      return s.type
        .map((t) => {
          if (typeof t !== 'string') throw new GenerateError(`${this.where}: type list holds a non-string`);
          return this.forType(t, s, indent);
        })
        .join(' | ');
    }
    if ('properties' in s || 'additionalProperties' in s) return this.object(s, indent);
    return null;
  }

  private forType(t: string, s: JsonObject, indent: string): string {
    switch (t) {
      case 'string':
        return 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array': {
        if (!('items' in s)) return 'unknown[]';
        const item = this.emit(s.items ?? true, indent);
        return /[|&\n]/.test(item) ? `Array<${item}>` : `${item}[]`;
      }
      case 'object':
        return this.object(s, indent);
      default:
        throw new GenerateError(`${this.where}: unsupported type "${t}"`);
    }
  }

  private object(s: JsonObject, indent: string): string {
    const props = isObject(s.properties) ? s.properties : {};
    const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
    const extra = s.additionalProperties;
    const names = Object.keys(props);
    for (const r of required) if (!(r in props)) names.push(r);
    if (names.length === 0) {
      if (extra === false) return 'Record<string, never>';
      if (isObject(extra) && affectsShape(extra)) return `Record<string, ${this.emit(extra, indent)}>`;
      return 'Record<string, unknown>';
    }
    const inner = `${indent}  `;
    const lines = names.map((name) => {
      const sub = props[name] ?? true;
      const doc = isObject(sub) && typeof sub.description === 'string' ? docComment(sub.description, inner) : '';
      return `${doc}${inner}${propertyKey(name)}${required.has(name) ? '' : '?'}: ${this.emit(sub, inner)};`;
    });
    if (isObject(extra) && affectsShape(extra)) lines.push(`${inner}[key: string]: unknown;`);
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
}

const BANNER = (version: string): string =>
  [
    '// GENERATED FILE - DO NOT EDIT.',
    `// Source: contracts/ (contract_version ${version}) via packages/contracts/scripts/generate.ts (lane B003).`,
    '// Regenerate with `pnpm contracts:gen`; `pnpm contracts:check` fails when this file is stale.',
    '',
  ].join('\n');

function typeDecl(name: string, schema: JsonObject, emitter: TypeEmitter): string {
  const notes: string[] = [];
  if (typeof schema.title === 'string') notes.push(schema.title);
  if (typeof schema.description === 'string') notes.push(schema.description);
  if (isExtensibleEnum(schema)) {
    notes.push('Extensible: readers must tolerate unknown values (validate with mode "tolerant"); this type lists the known values.');
  }
  const doc = notes.length > 0 ? docComment(notes.join('\n\n'), '') : '';
  return `${doc}export type ${name} = ${emitter.emit(schema, '')};\n`;
}

function emitApiTypes(c: Contracts): string {
  const out = [BANNER(c.version), '// TypeScript types for every components.schemas entry of contracts/openapi.yaml.\n'];
  if (!c.api) {
    out.push('export {};\n');
    return out.join('\n');
  }
  const names = new Set(Object.keys(c.api));
  const emitter = new TypeEmitter('contracts/openapi.yaml', (ref) => {
    const name = ref.slice('#/$defs/'.length);
    if (!ref.startsWith('#/$defs/') || !names.has(name)) throw new GenerateError(`contracts/openapi.yaml: unresolved $ref ${ref}`);
    return name;
  });
  for (const [name, schema] of Object.entries(c.api)) {
    out.push(typeDecl(name, isObject(schema) ? schema : {}, emitter));
  }
  return out.join('\n');
}

const kindTypeName = (kind: string): string => pascal(kind);

function emitWireTypes(c: Contracts, catalogue: EventKindInfo[]): string {
  const byId = new Map(c.schemas.map((s) => [s.id, s]));
  const events = c.schemas.find((s) => s.stem === 'events');
  const defName = new Map<string, string>();
  for (const k of catalogue) {
    if (k.clearDef) defName.set(k.clearDef, `${kindTypeName(k.kind)}Payload`);
    if (k.secretDef) defName.set(k.secretDef, `${kindTypeName(k.kind)}Secret`);
  }
  const eventDefs = events && isObject(events.schema.$defs) ? events.schema.$defs : {};
  for (const name of Object.keys(eventDefs)) {
    if (!defName.has(name)) throw new GenerateError(`contracts/schemas/events.schema.json: $defs/${name} belongs to no kind`);
  }
  const resolverFor = (file: SchemaFile) => (ref: string): string => {
    if (ref.startsWith('#/$defs/')) {
      const name = defName.get(ref.slice('#/$defs/'.length));
      if (file.stem === 'events' && name) return name;
    } else if (!ref.startsWith('#')) {
      const target = byId.get(new URL(ref, file.id).href);
      if (target && target.stem !== 'events') return target.typeName;
    }
    throw new GenerateError(`contracts/schemas/${file.file}: unresolved $ref ${ref}`);
  };

  const out = [
    BANNER(c.version),
    "import type * as Api from './api.js';\n",
    '// Types for contracts/schemas/*.json. Conditional rules (if/then/not) are enforced by the',
    '// validators, not by these types.\n',
  ];
  for (const s of c.schemas) {
    if (s.stem === 'events') continue;
    out.push(typeDecl(s.typeName, s.schema, new TypeEmitter(`contracts/schemas/${s.file}`, resolverFor(s))));
  }
  if (events) {
    const emitter = new TypeEmitter(`contracts/schemas/${events.file}`, resolverFor(events));
    out.push('// Event payloads: `<Kind>Payload` is the cleartext `p`, `<Kind>Secret` the decrypted `ct`.\n');
    for (const [name, schema] of Object.entries(eventDefs)) {
      out.push(typeDecl(defName.get(name) ?? name, isObject(schema) ? schema : {}, emitter));
    }
  }

  out.push(
    '/** Every event kind in the CT-WS-SESSION-EVENTS catalogue, in catalogue order. */',
    `export type EventKind =\n${catalogue.map((k) => `  | ${JSON.stringify(k.kind)}`).join('\n') || '  never'};\n`,
    '/** encrypted: `ct` only; hybrid: `p` and `ct`; clear: `p` only (CT-WS-SESSION-EVENTS). */',
    "export type PayloadMode = 'encrypted' | 'hybrid' | 'clear';\n",
    '/** Cleartext payload type per kind (kinds with a `p`). */',
    `export interface EventPayloads {\n${catalogue
      .filter((k) => k.clearDef)
      .map((k) => `  ${JSON.stringify(k.kind)}: ${defName.get(k.clearDef ?? '')};`)
      .join('\n')}\n}\n`,
    '/** Decrypted secret payload type per kind (kinds with a secret schema). */',
    `export interface EventSecrets {\n${catalogue
      .filter((k) => k.secretDef)
      .map((k) => `  ${JSON.stringify(k.kind)}: ${defName.get(k.secretDef ?? '')};`)
      .join('\n')}\n}\n`,
    '/** One catalogue entry: frame type, payload mode and the cleartext fields the relay may read. */',
    'export interface EventCatalogueEntry {\n  readonly t: string;\n  readonly mode: PayloadMode;\n  readonly clearFields: readonly string[];\n  readonly secret: boolean;\n}\n',
    '/** The event catalogue, generated from contracts/schemas/events.schema.json. */',
    `export const EVENT_CATALOGUE = {\n${catalogue
      .map(
        (k) =>
          `  ${JSON.stringify(k.kind)}: { t: ${JSON.stringify(k.t)}, mode: ${JSON.stringify(k.mode)}, clearFields: ${JSON.stringify(k.clearFields)}, secret: ${k.secretDef !== null} },`,
      )
      .join('\n')}\n} as const satisfies Record<EventKind, EventCatalogueEntry>;\n`,
    '/** Every event kind, in catalogue order. */',
    `export const EVENT_KINDS: readonly EventKind[] = ${JSON.stringify(catalogue.map((k) => k.kind))};\n`,
  );

  const keys: string[] = [];
  for (const s of c.schemas) keys.push(`  ${JSON.stringify(s.stem)}: ${s.stem === 'events' ? 'Envelope' : s.typeName};`);
  for (const k of catalogue) {
    if (k.clearDef) keys.push(`  ${JSON.stringify(`event/${k.kind}`)}: ${defName.get(k.clearDef)};`);
  }
  for (const k of catalogue) {
    if (k.secretDef) keys.push(`  ${JSON.stringify(`event-secret/${k.kind}`)}: ${defName.get(k.secretDef)};`);
  }
  for (const name of Object.keys(c.api ?? {})) keys.push(`  ${JSON.stringify(`api/${name}`)}: Api.${name};`);
  out.push(
    '/**',
    ' * Value type per schema key. Keys: a schema file stem (`events` validates a whole frame),',
    ' * `event/<kind>` (cleartext payload), `event-secret/<kind>` (secret payload), `api/<Name>`',
    ' * (an OpenAPI component).',
    ' */',
    `export interface SchemaTypes {\n${keys.join('\n')}\n}\n`,
    '/** Every key accepted by `validate()`. */',
    'export type SchemaKey = keyof SchemaTypes;\n',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Validators (Ajv standalone)

/** Relaxes enums documented as extensible to plain strings (the tolerant reader view). */
function relaxExtensibleEnums(node: Json, where: string): Json {
  return deepMap(node, (n) => {
    if (!isExtensibleEnum(n)) return n;
    const values = n.enum as Json[];
    if (!values.every((v) => typeof v === 'string')) {
      throw new GenerateError(`${where}: an extensible enum must hold only strings`);
    }
    const relaxed: JsonObject = { ...n, type: 'string' };
    delete relaxed.enum;
    return relaxed;
  });
}

/** True if `start` (inside `doc`) reaches an extensible enum through its own nodes or any $ref. */
function reachesExtensible(start: Json, doc: { id: string; root: JsonObject }, docs: Map<string, JsonObject>): boolean {
  const seen = new Set<Json>();
  const stack: Array<{ node: Json; doc: { id: string; root: JsonObject } }> = [{ node: start, doc }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top || seen.has(top.node)) continue;
    seen.add(top.node);
    const { node } = top;
    if (Array.isArray(node)) {
      for (const n of node) stack.push({ node: n, doc: top.doc });
      continue;
    }
    if (!isObject(node)) continue;
    if (isExtensibleEnum(node)) return true;
    if (typeof node.$ref === 'string') {
      const url = new URL(node.$ref, top.doc.id);
      const fragment = decodeURIComponent(url.hash.slice(1));
      url.hash = '';
      const root = docs.get(url.href);
      if (root) {
        let target: Json | undefined = root;
        for (const part of fragment.split('/').slice(1)) {
          target = isObject(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
        }
        if (target !== undefined) stack.push({ node: target, doc: { id: url.href, root } });
      }
    }
    for (const v of Object.values(node)) stack.push({ node: v, doc: top.doc });
  }
  return false;
}

function emitValidators(c: Contracts, catalogue: EventKindInfo[]): { js: string; dts: string } {
  const ajv = new Ajv2020({
    code: { source: true, esm: true, lines: true },
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
    allErrors: false,
    discriminator: true,
    validateFormats: true,
  });
  addFormats(ajv, { mode: 'full', formats: FORMATS as never });

  const docs = new Map<string, JsonObject>();
  const add = (schema: JsonObject, label: string): void => {
    try {
      ajv.addSchema(schema);
    } catch (e) {
      throw new GenerateError(`${label}: ${(e as Error).message}`);
    }
    if (typeof schema.$id === 'string') docs.set(schema.$id, schema);
  };
  for (const s of c.schemas) {
    add(s.schema, `contracts/schemas/${s.file}`);
    const tolerant = asObject(relaxExtensibleEnums(s.schema, `contracts/schemas/${s.file}`), s.file);
    add({ ...tolerant, $id: new URL(s.file, TOLERANT_BASE).href }, `contracts/schemas/${s.file} (tolerant)`);
  }
  if (c.api) {
    add({ $schema: DIALECT, $id: OPENAPI_ID, $defs: c.api }, 'contracts/openapi.yaml');
    add(
      { $schema: DIALECT, $id: OPENAPI_TOLERANT_ID, $defs: asObject(relaxExtensibleEnums(c.api, 'contracts/openapi.yaml'), 'openapi') },
      'contracts/openapi.yaml (tolerant)',
    );
  }

  const exportsByIdent: Record<string, string> = {};
  const keyToIdent: Array<[string, string]> = [];
  const register = (key: string, ref: string, tolerantRef: string | null, node: Json, doc: { id: string; root: JsonObject }): void => {
    const ident = `v_${key.replace(/[^A-Za-z0-9]+/g, '_')}`;
    if (ident in exportsByIdent) throw new GenerateError(`two schema keys map to the export name ${ident}`);
    exportsByIdent[ident] = ref;
    keyToIdent.push([key, ident]);
    if (tolerantRef && reachesExtensible(node, doc, docs)) {
      exportsByIdent[`${ident}__tolerant`] = tolerantRef;
      keyToIdent.push([`${key}#tolerant`, `${ident}__tolerant`]);
    }
  };
  for (const s of c.schemas) {
    register(s.stem, s.id, new URL(s.file, TOLERANT_BASE).href, s.schema, { id: s.id, root: s.schema });
  }
  const events = c.schemas.find((s) => s.stem === 'events');
  if (events) {
    const defs = asObject(events.schema.$defs ?? {}, 'events $defs');
    const doc = { id: events.id, root: events.schema };
    const tolerantId = new URL(events.file, TOLERANT_BASE).href;
    for (const k of catalogue) {
      if (k.clearDef) register(`event/${k.kind}`, `${events.id}#/$defs/${k.clearDef}`, `${tolerantId}#/$defs/${k.clearDef}`, defs[k.clearDef] ?? true, doc);
    }
    for (const k of catalogue) {
      if (k.secretDef) register(`event-secret/${k.kind}`, `${events.id}#/$defs/${k.secretDef}`, `${tolerantId}#/$defs/${k.secretDef}`, defs[k.secretDef] ?? true, doc);
    }
  }
  if (c.api) {
    const root: JsonObject = { $id: OPENAPI_ID, $defs: c.api };
    for (const [name, schema] of Object.entries(c.api)) {
      register(`api/${name}`, `${OPENAPI_ID}#/$defs/${name}`, `${OPENAPI_TOLERANT_ID}#/$defs/${name}`, schema, { id: OPENAPI_ID, root });
    }
  }

  let code: string;
  try {
    code = standaloneCode(ajv, exportsByIdent);
  } catch (e) {
    throw new GenerateError(`Ajv could not compile the contracts: ${(e as Error).message}`);
  }
  if (/\bnew Function\b|\beval\s*\(/.test(code)) {
    throw new GenerateError('generated validators contain eval or new Function; refusing to emit them');
  }
  for (const m of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (!ALLOWED_RUNTIME_REQUIRE.test(m[1] ?? '')) {
      throw new GenerateError(`generated validators load an unexpected runtime module "${m[1]}"`);
    }
  }
  const body = code.replace(/^"use strict";\n?/, '');
  // Plain JavaScript on purpose: the TypeScript compiler overflows its stack on functions this long,
  // so it only ever sees validators.d.ts. Imported through the package alias #generated/validators.
  const js = [
    BANNER(c.version),
    '// Precompiled Ajv standalone validators (JSON Schema 2020-12). Runtime helpers come from',
    '// ajv/dist/runtime and ajv-formats; no schema is compiled at runtime. Types: validators.d.ts.',
    "import { createRequire } from 'node:module';\n",
    'const require = createRequire(import.meta.url);\n',
    body.trimEnd(),
    '',
    '/** Every validator by schema key; `<key>#tolerant` exists only where an extensible enum is reachable. */',
    'export const VALIDATORS = Object.freeze({',
    ...keyToIdent.map(([key, ident]) => `  ${JSON.stringify(key)}: ${ident},`),
    '});',
    '',
  ].join('\n');
  const dts = [
    BANNER(c.version),
    '/** One Ajv error from a generated validator (they stop at the first error, plus wrapper errors). */',
    'export interface AjvErrorObject {',
    '  instancePath: string;',
    '  schemaPath: string;',
    '  keyword: string;',
    '  params: Record<string, unknown>;',
    '  message?: string;',
    '}',
    '',
    '/** A precompiled validator: returns true when valid; when false, `errors` holds the reason. */',
    'export interface RawValidator {',
    '  (data: unknown): boolean;',
    '  errors?: AjvErrorObject[] | null;',
    '}',
    '',
    '/** Every validator by schema key; `<key>#tolerant` exists only where an extensible enum is reachable. */',
    'export declare const VALIDATORS: Readonly<Record<string, RawValidator>>;',
    '',
  ].join('\n');
  return { js, dts };
}

// ---------------------------------------------------------------------------------------------
// Error registry, product states, metadata

function emitErrors(c: Contracts): string {
  const out = [BANNER(c.version), '// CT-ERR error registry from contracts/errors.json.\n'];
  if (!c.errors) {
    out.push('export const ERROR_TYPE_BASE = null;', 'export const ERRORS = {} as const;', 'export type ErrorCode = never;\n');
    return out.join('\n');
  }
  const list = c.errors.errors;
  if (!Array.isArray(list)) throw new GenerateError('contracts/errors.json: errors must be an array');
  const seen = new Set<string>();
  const lines = list.map((e, i) => {
    const entry = asObject(e, `contracts/errors.json errors/${i}`);
    const { code, status, area, retryable, title, type } = entry;
    if (typeof code !== 'string' || !/^[a-z0-9_]+$/.test(code)) throw new GenerateError(`contracts/errors.json errors/${i}: code must be snake_case`);
    if (seen.has(code)) throw new GenerateError(`contracts/errors.json: code ${code} appears twice`);
    seen.add(code);
    if (typeof status !== 'number' || !Number.isInteger(status) || typeof area !== 'string' || typeof retryable !== 'boolean' || typeof title !== 'string' || typeof type !== 'string') {
      throw new GenerateError(`contracts/errors.json: ${code} needs status, area, retryable, title and type`);
    }
    return `  ${code}: { status: ${status}, area: ${JSON.stringify(area)}, retryable: ${retryable}, title: ${JSON.stringify(title)}, type: ${JSON.stringify(type)} },`;
  });
  out.push(
    '/** Base URI of every problem `type`. */',
    `export const ERROR_TYPE_BASE = ${JSON.stringify(typeof c.errors.base === 'string' ? c.errors.base : null)};\n`,
    '/** Every stable error code with its HTTP status, area, retryability, title and problem type. */',
    `export const ERRORS = {\n${lines.join('\n')}\n} as const;\n`,
    '/** A stable error code (CT-ERR). */',
    'export type ErrorCode = keyof typeof ERRORS;\n',
  );
  return out.join('\n');
}

function emitStateMap(c: Contracts): string {
  const entries = Object.entries(c.stateMap);
  for (const [k, v] of entries) {
    if (typeof v !== 'string') throw new GenerateError(`contracts/state-map.json: ${k} must map to a string`);
  }
  return [
    BANNER(c.version),
    '// CT-STATE-MAP: product state name -> mascot animation, from contracts/state-map.json.\n',
    '/** Every product state and the animation it maps to. */',
    `export const STATE_MAP = {\n${entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n} as const;\n`,
    '/** A product state name. Receivers tolerate unknown names (CT-STATE-MAP rule 1). */',
    'export type ProductState = keyof typeof STATE_MAP;\n',
    '/** Every product state name, in contract order. */',
    `export const PRODUCT_STATES: readonly ProductState[] = ${JSON.stringify(entries.map(([k]) => k))};\n`,
  ].join('\n');
}

function emitMeta(c: Contracts): string {
  return [
    BANNER(c.version),
    '/** contract_version from contracts/index.json (CT-VER build metadata). */',
    `export const CONTRACT_VERSION = ${JSON.stringify(c.version)};\n`,
    '/** SHA-256 of contracts/CONTRACTS.lock when this code was generated. */',
    `export const CONTRACTS_LOCK_SHA256: string | null = ${JSON.stringify(c.lockSha256)};\n`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Entry points

/** Generates every output file in memory. Throws GenerateError and writes nothing on failure. */
export function generate(contractsDir: string = DEFAULT_CONTRACTS_DIR): GenerateResult {
  const warnings: string[] = [];
  const c = loadContracts(contractsDir, warnings);
  const catalogue = readCatalogue(c.schemas.find((s) => s.stem === 'events'));
  const validators = emitValidators(c, catalogue);
  const files = new Map<string, string>([
    ['api.ts', emitApiTypes(c)],
    ['errors.ts', emitErrors(c)],
    ['meta.ts', emitMeta(c)],
    ['state-map.ts', emitStateMap(c)],
    ['types.ts', emitWireTypes(c, catalogue)],
    ['validators.d.ts', validators.dts],
    ['validators.js', validators.js],
  ]);
  return { files, warnings };
}

/** Lists generated files that are missing, different, or no longer generated in `outDir`. */
export function diffOutput(files: Map<string, string>, outDir: string): string[] {
  const problems: string[] = [];
  for (const [name, content] of files) {
    const path = join(outDir, name);
    if (!existsSync(path)) problems.push(`${name}: missing`);
    else if (readFileSync(path, 'utf8') !== content) problems.push(`${name}: stale`);
  }
  if (existsSync(outDir)) {
    for (const name of readdirSync(outDir).sort()) if (!files.has(name)) problems.push(`${name}: no longer generated`);
  }
  return problems;
}

/** Replaces `outDir` with exactly `files` (LF line endings). */
export function writeOutput(files: Map<string, string>, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(outDir, name), content, 'utf8');
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** CLI: returns the process exit code. */
export function main(args: string[]): number {
  const contractsDir = resolve(argValue(args, '--contracts') ?? DEFAULT_CONTRACTS_DIR);
  const outDir = resolve(argValue(args, '--out') ?? DEFAULT_OUT_DIR);
  let result: GenerateResult;
  try {
    result = generate(contractsDir);
  } catch (e) {
    process.stderr.write(`contracts:gen failed: ${(e as Error).message}\n`);
    return 1;
  }
  for (const w of result.warnings) process.stderr.write(`${w}\n`);
  if (args.includes('--check')) {
    const problems = diffOutput(result.files, outDir);
    if (problems.length > 0) {
      process.stderr.write(
        `Generated contract code is out of date; run \`pnpm contracts:gen\`:\n${problems.map((p) => `  ${p}`).join('\n')}\n`,
      );
      return 1;
    }
    process.stdout.write(`Generated contract code is up to date (${result.files.size} files).\n`);
    return 0;
  }
  writeOutput(result.files, outDir);
  process.stdout.write(`Wrote ${result.files.size} files to ${outDir}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
