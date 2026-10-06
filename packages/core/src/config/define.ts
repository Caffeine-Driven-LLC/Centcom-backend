/**
 * Typed configuration loader (B004). `defineConfig(schema, env)` parses the environment once,
 * through a zod schema whose top level is an object of environment keys, and returns a
 * deep-frozen, typed config object or throws one ConfigError listing every problem.
 *
 * Owns: blank-as-unset, KEY_FILE secrets, value-free errors and warnings, strict env helpers
 * (integer, boolean, URL) and deep freezing. Must not: put a config value or a secret file path
 * into an error, warning or thrown object, or read keys the schema does not declare.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
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

/**
 * Reads one KEY_FILE secret: its permission bits and at most `maxBytes` of UTF-8 content.
 * Throws an error whose `code` is `ENOTREG` (not a regular file), `EFBIG` (over `maxBytes`) or an
 * fs code such as `ENOENT`. Tests inject a fake; the default is `readSecretFileSync`.
 */
export type SecretFileReader = (
  path: string,
  maxBytes: number,
) => { mode: number; content: string };

/** Options for `defineConfig`. */
export interface DefineConfigOptions {
  /** Receives warnings; defaults to `process.emitWarning` until logging (B005) is wired in. */
  onWarning?: (warning: ConfigWarning) => void;
  readSecretFile?: SecretFileReader;
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

const fileError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** O_NONBLOCK: opening a FIFO for reading must not hang startup (it is then refused by fstat). */
const SECRET_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * The default SecretFileReader: one file descriptor for the type check, the permission bits and
 * a bounded read, so the file cannot be swapped between check and read, and a file whose size is
 * misreported (procfs) still cannot exceed `maxBytes`.
 */
export function readSecretFileSync(
  path: string,
  maxBytes: number,
): { mode: number; content: string } {
  const fd = openSync(path, SECRET_OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw fileError('ENOTREG', 'not a regular file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > maxBytes) throw fileError('EFBIG', 'file too large');
    return { mode: stat.mode, content: buffer.toString('utf8', 0, length) };
  } finally {
    closeSync(fd);
  }
}

/** Removes a UTF-8 byte-order mark and trailing newlines (`\n`, `\r\n`), in linear time. */
function trimSecretFile(content: string): string {
  const start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  let end = content.length;
  while (end > start && content.charCodeAt(end - 1) === 0x0a) {
    end -= 1;
    if (end > start && content.charCodeAt(end - 1) === 0x0d) end -= 1;
  }
  return content.slice(start, end);
}

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
  const readSecretFile = options.readSecretFile ?? readSecretFileSync;
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
    let file: { mode: number; content: string };
    try {
      file = readSecretFile(path.trim(), MAX_SECRET_FILE_BYTES);
    } catch (e) {
      const code =
        typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
          ? e.code
          : 'error';
      if (code === 'ENOTREG' || code === 'EISDIR') fail('must point to a regular file');
      else if (code === 'EFBIG') fail(`file is larger than ${MAX_SECRET_FILE_BYTES} bytes`);
      else fail(`file cannot be read (${code})`);
      continue;
    }
    // World-readable only, as the card asks: group-readable is the usual way to share a secret
    // with a service group, and warning on it would make the warning noise.
    if (checkPermissions && (file.mode & 0o004) !== 0) {
      onWarning({
        key: fileKey,
        problem: 'secret file is readable by every user; restrict it to the service user',
      });
    }
    // Only a byte-order mark and trailing newlines are removed; other whitespace is part of the
    // value, exactly as for a KEY given directly in the environment.
    const value = trimSecretFile(file.content);
    if (!isBlank(value)) out.values[key] = value;
  }
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes the raw value from a message authored by a schema (defence in depth: built-in messages
 * never contain values). Values of 4+ characters are replaced wherever they occur; shorter ones
 * only as whole tokens, since they also occur inside ordinary words.
 */
function scrub(message: string, raw: string | undefined): string {
  if (raw === undefined || raw === '') return message;
  if (raw.length >= 4) return message.split(raw).join(REDACTED);
  const token = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(raw)}(?![\\p{L}\\p{N}])`, 'gu');
  return message.replace(token, REDACTED);
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
