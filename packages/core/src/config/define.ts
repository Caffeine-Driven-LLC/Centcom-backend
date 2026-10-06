/**
 * Typed configuration loader (B004). `defineConfig(schema, env)` parses the environment once,
 * through a zod schema whose top level is an object of environment keys, and returns a
 * deep-frozen, typed config object or throws one ConfigError listing every problem.
 *
 * Owns: blank-as-unset, KEY_FILE secrets, value-free errors and warnings, strict env helpers
 * (integer, boolean, URL) and deep freezing. Must not: put a config value or a secret file path
 * into an error, warning or thrown object, or read keys the schema does not declare.
 */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { REDACTED, Secret } from './secret.js';

/** An environment: variable name to raw value. Defaults to `process.env` at the entrypoint. */
export type Env = Readonly<Record<string, string | undefined>>;

/** One configuration problem. `problem` never contains the value. */
export interface ConfigIssue {
  readonly key: string;
  readonly problem: string;
}

/** A non-fatal configuration finding (e.g. a world-readable secret file). Names keys, never values. */
export type ConfigWarning = ConfigIssue;

/** Thrown when configuration is invalid; lists every problem at once, by key name only. */
export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  ${i.key}: ${i.problem}`).join('\n')}`);
    this.issues = Object.freeze(
      issues.map((i) => Object.freeze({ key: i.key, problem: i.problem })),
    );
  }
}

/** File access for KEY_FILE secrets (tests inject a fake; the default is node:fs). */
export interface SecretFiles {
  stat(path: string): { mode: number; size: number; isFile(): boolean };
  read(path: string): string;
}

/** Options for `defineConfig`. */
export interface DefineConfigOptions {
  /** Receives warnings; defaults to `process.emitWarning` until logging (B005) is wired in. */
  onWarning?: (warning: ConfigWarning) => void;
  files?: SecretFiles;
  /** Used to skip the permission check on Windows, where mode bits are not meaningful. */
  platform?: string;
}

/** Secret files larger than this are refused (they are short tokens, URLs or keys). */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** A readonly view of a config object; Secrets stay Secrets. */
export type DeepReadonly<T> =
  T extends Secret<infer U>
    ? Secret<U>
    : T extends (...args: never[]) => unknown
      ? T
      : T extends readonly (infer E)[]
        ? readonly DeepReadonly<E>[]
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

const nodeFiles: SecretFiles = {
  stat: (path) => statSync(path),
  read: (path) => readFileSync(path, 'utf8'),
};

const defaultWarning = (w: ConfigWarning): void => {
  process.emitWarning(`${w.key}: ${w.problem}`, { code: 'CENTCOM_CONFIG' });
};

const isBlank = (v: string | undefined): v is undefined => v === undefined || v.trim() === '';

/** Freezes `value` and everything reachable from it (typed arrays and frozen objects excepted). */
export function deepFreeze<T>(value: T): T {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.isFrozen(value) ||
    ArrayBuffer.isView(value)
  )
    return value;
  for (const key of Reflect.ownKeys(value))
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return Object.freeze(value);
}

/** The environment keys a schema reads: the keys of its top-level object (through pipes). */
function envKeys(schema: z.ZodType): string[] {
  let node: unknown = schema;
  while (node instanceof z.ZodPipe) node = node.in;
  if (!(node instanceof z.ZodObject)) {
    throw new TypeError(
      'defineConfig needs a z.object() of environment keys (optionally refined or transformed)',
    );
  }
  return Object.keys(node.shape);
}

interface ReadResult {
  values: Record<string, string>;
  issues: ConfigIssue[];
  /** Keys whose KEY_FILE failed: their own "is required" would only repeat the problem. */
  failedFiles: Set<string>;
}

/**
 * Collects the declared keys from `env`: blank values count as unset, and KEY_FILE (a path) wins
 * over KEY. File problems are reported against KEY_FILE without the path.
 */
function readEnv(keys: readonly string[], env: Env, options: DefineConfigOptions): ReadResult {
  const files = options.files ?? nodeFiles;
  const onWarning = options.onWarning ?? defaultWarning;
  const checkPermissions =
    (options.platform ?? process.platform) !== 'win32' && env.NODE_ENV?.trim() === 'production';
  const out: ReadResult = { values: {}, issues: [], failedFiles: new Set() };

  for (const key of keys) {
    const fileKey = `${key}_FILE`;
    const path = env[fileKey];
    if (isBlank(path)) {
      const raw = env[key];
      if (!isBlank(raw)) out.values[key] = raw;
      continue;
    }
    const fail = (problem: string): void => {
      out.issues.push({ key: fileKey, problem });
      out.failedFiles.add(key);
    };
    let content: string;
    try {
      const stat = files.stat(path.trim());
      if (!stat.isFile()) {
        fail('must point to a regular file');
        continue;
      }
      if (stat.size > MAX_SECRET_FILE_BYTES) {
        fail(`file is larger than ${MAX_SECRET_FILE_BYTES} bytes`);
        continue;
      }
      if (checkPermissions && (stat.mode & 0o004) !== 0) {
        onWarning({
          key: fileKey,
          problem: 'secret file is readable by every user; restrict it to the service user',
        });
      }
      content = files.read(path.trim());
    } catch (e) {
      const code =
        typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
          ? e.code
          : 'error';
      fail(`file cannot be read (${code})`);
      continue;
    }
    const value = content.replace(/(?:\r?\n)+$/, '');
    if (!isBlank(value)) out.values[key] = value;
  }
  return out;
}

/** Replaces any occurrence of the raw value in a message authored by a schema (defence in depth). */
function scrub(message: string, raw: string | undefined): string {
  return raw !== undefined && raw.length >= 4 ? message.split(raw).join(REDACTED) : message;
}

const ARTICLE = /^[aeiou]/;

/** A value-free description of one zod issue. */
function problemFor(issue: z.core.$ZodIssue, raw: string): string {
  switch (issue.code) {
    case 'invalid_type':
      return `must be ${ARTICLE.test(issue.expected) ? 'an' : 'a'} ${issue.expected}`;
    case 'too_small':
      return issue.origin === 'string'
        ? `must be at least ${issue.minimum} characters`
        : `must be at least ${issue.minimum}`;
    case 'too_big':
      return issue.origin === 'string'
        ? `must be at most ${issue.maximum} characters`
        : `must be at most ${issue.maximum}`;
    case 'invalid_value':
      return `must be one of: ${issue.values.map(String).join(', ')}`;
    case 'invalid_format':
      return issue.format === 'regex'
        ? scrub(issue.message, raw)
        : `must be a valid ${issue.format}`;
    case 'custom':
      return scrub(issue.message, raw);
    default:
      return 'is invalid';
  }
}

/**
 * Parses the keys `schema` declares from `env` (default `process.env`, read here and in
 * entrypoints only), applying defaults and KEY_FILE secrets. Returns a deep-frozen config, or
 * throws a ConfigError naming every invalid key (never a value).
 */
export function defineConfig<S extends z.ZodType>(
  schema: S,
  env: Env = process.env,
  options: DefineConfigOptions = {},
): DeepReadonly<z.output<S>> {
  const { values, issues, failedFiles } = readEnv(envKeys(schema), env, options);
  const result = schema.safeParse(values);
  if (!result.success || issues.length > 0) {
    for (const issue of result.error?.issues ?? []) {
      const key = String(issue.path[0] ?? '(config)');
      if (failedFiles.has(key)) continue;
      const raw = values[key];
      // An absent key that fails its own type check (invalid_type for strings, invalid_value for
      // enums) is simply missing; custom (cross-field) rules keep their own message.
      const missing = raw === undefined && issue.code !== 'custom';
      issues.push({ key, problem: missing ? 'is required' : problemFor(issue, raw ?? '') });
    }
    throw new ConfigError(issues);
  }
  return deepFreeze(result.data) as DeepReadonly<z.output<S>>;
}

const INTEGER = /^-?\d+$/;

/** An integer in [min, max], given as decimal digits (no `1e3`, `0x10` or blanks). */
export function envInt({ min, max }: { min: number; max: number }) {
  return z
    .string()
    .regex(INTEGER, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .meta({ envType: `integer ${min}..${max}` });
}

/** A boolean given as `0`/`1` or `false`/`true` (lower case). */
export function envBool() {
  return z
    .enum(['0', '1', 'true', 'false'])
    .transform((v) => v === '1' || v === 'true')
    .meta({ envType: 'boolean (0, 1, true, false)' });
}

/**
 * An absolute URL whose scheme is one of `protocols` (e.g. `['https:']`). With `plain`, user
 * info, query and fragment are rejected (for URLs that are shown or linked to).
 */
export function envUrl({
  protocols,
  plain = false,
}: {
  protocols: readonly string[];
  plain?: boolean;
}) {
  const schemes = protocols.map((p) => p.replace(/:$/, '://')).join(' or ');
  return z
    .string()
    .superRefine((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: `must be an absolute ${schemes} URL` });
        return;
      }
      if (!protocols.includes(url.protocol))
        ctx.addIssue({ code: 'custom', message: `must start with ${schemes}` });
      else if (!url.hostname) ctx.addIssue({ code: 'custom', message: 'must name a host' });
      else if (plain && (url.username || url.password || url.search || url.hash)) {
        ctx.addIssue({
          code: 'custom',
          message: 'must not contain credentials, a query or a fragment',
        });
      }
    })
    .meta({ envType: `URL (${schemes})` });
}
