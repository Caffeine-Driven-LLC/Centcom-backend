/**
 * Flag definitions (B083, CT-API-FLAGS): what a flag is, the strict check of a definition an admin
 * stores (`checkFlagDef`), and the lenient read of a stored one (`readStoredFlag`).
 *
 * A flag has a `type` (`bool`, `string`, `number` or `json`, an object), a `value` served to callers
 * its rules let in and a `default` served to everyone else. All its `rules` must pass:
 *
 * | Rule | Passes when |
 * |---|---|
 * | `{type: 'percent', percent}` | the caller's user id hashes into the first `percent` % (0 to 100, two decimals) |
 * | `{type: 'plans', plans}` | the caller's plan (`free`, `pro`, `team`) is listed |
 * | `{type: 'workspaces', workspaces}` | the caller's active workspace is listed (at most 1 000 `wsp_` ids) |
 * | `{type: 'client_version', min?, max?}` | the caller's client version is in `[min, max]`; otherwise the flag is not shown at all |
 *
 * `kill` serves the default to everyone, whatever the rules. `public` flags may be shown to
 * anonymous callers (only when they have no percent, plan or workspace rule); `server_only` flags
 * are never sent to clients.
 *
 * No secrets or personal data: a key may not have a segment such as `secret`, `token` or `key`,
 * and no string in a value may look like a credential, an e-mail or an IP address (B036's patterns).
 *
 * Owns: the definition format and its limits. Must not: accept a definition it cannot evaluate.
 */
import { isId } from '@centcom/contracts';
import { isSecretLike, validationFailed, type FieldError } from '@centcom/core';
import type { FlagType } from '@centcom/db';
import { parseSemver, type Semver } from './version.js';

export type { FlagType };

/** A flag's value: JSON of its type. */
export type FlagValue = boolean | string | number | Record<string, unknown>;

/** The plans a `plans` rule may name (CT-ENTITLEMENTS). */
export const PLANS = ['free', 'pro', 'team'] as const;
export type Plan = (typeof PLANS)[number];

/** A targeting rule. */
export type FlagRule =
  | { type: 'percent'; percent: number }
  | { type: 'plans'; plans: Plan[] }
  | { type: 'workspaces'; workspaces: string[] }
  | { type: 'client_version'; min?: string; max?: string };

/** A flag as an admin defines it (B087's tooling calls `setFlag` with one). */
export interface FlagDef {
  key: string;
  type: FlagType;
  value: FlagValue;
  default: FlagValue;
  public?: boolean;
  server_only?: boolean;
  kill?: boolean;
  rules?: FlagRule[];
}

/** A stored flag, complete. */
export interface StoredFlagDef extends Required<FlagDef> {
  updated_by: string;
  updated_at: string;
}

/** A flag ready to evaluate: rules parsed, version bounds as numbers. */
export interface EvalFlag {
  key: string;
  value: FlagValue;
  default: FlagValue;
  public: boolean;
  serverOnly: boolean;
  kill: boolean;
  /** Percent of users let in, as basis points (0..10 000); null without a percent rule. */
  basisPoints: number | null;
  plans: ReadonlySet<string> | null;
  workspaces: ReadonlySet<string> | null;
  version: { min: Semver | null; max: Semver | null } | null;
  /** A stored rule this code does not know: the flag serves its default. */
  broken: boolean;
}

/** Limits a definition is checked against (FLAGS_MAX_VALUE_BYTES). */
export interface FlagLimits {
  maxValueBytes: number;
}

/** CT-API-FLAGS: flag keys match `[a-z0-9_.-]{1,64}`. */
export const FLAG_KEY = /^[a-z0-9_.-]{1,64}$/;
/** Key segments that name a secret or a credential: such flags are refused. */
export const DENIED_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'token',
  'tokens',
  'key',
  'keys',
  'apikey',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'private',
  'pem',
  'dsn',
]);
/** Workspaces a `workspaces` rule may list. */
export const MAX_RULE_WORKSPACES = 1000;
/** Rules one flag may carry. */
export const MAX_RULES = 8;

/** The details of refusals (GUIDELINES §3.4). */
export const DEFINITION_DETAILS = Object.freeze({
  invalid: 'The flag definition is not valid.',
} as const);

const TYPES: ReadonlySet<string> = new Set(['bool', 'string', 'number', 'json']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when `value` is JSON of `type`. */
function hasType(type: FlagType, value: unknown): value is FlagValue {
  if (type === 'bool') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return isRecord(value);
}

/** Every string in a JSON value, keys included. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

function checkValue(
  type: FlagType,
  value: unknown,
  pointer: string,
  limits: FlagLimits,
  issues: FieldError[],
): void {
  if (!hasType(type, value)) {
    issues.push({ pointer, code: 'invalid_type', detail: `must be a ${type} value` });
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > limits.maxValueBytes) {
    issues.push({
      pointer,
      code: 'too_long',
      detail: `is ${bytes} bytes; at most ${limits.maxValueBytes} are allowed`,
    });
    return;
  }
  if (strings(value).some(isSecretLike)) {
    issues.push({
      pointer,
      code: 'not_allowed',
      detail: 'must not hold a credential, an e-mail address or an IP address',
    });
  }
}

function checkRule(rule: unknown, pointer: string, issues: FieldError[]): FlagRule | null {
  if (!isRecord(rule)) {
    issues.push({ pointer, code: 'invalid_type', detail: 'must be a rule object' });
    return null;
  }
  const bad = (field: string, detail: string): null => {
    issues.push({ pointer: `${pointer}/${field}`, code: 'invalid_value', detail });
    return null;
  };
  switch (rule['type']) {
    case 'percent': {
      const p = rule['percent'];
      if (
        typeof p !== 'number' ||
        !(p >= 0 && p <= 100) ||
        Math.abs(Math.round(p * 100) - p * 100) > 1e-6
      ) {
        return bad('percent', 'must be 0 to 100, with at most two decimals');
      }
      return { type: 'percent', percent: p };
    }
    case 'plans': {
      const plans = rule['plans'];
      if (
        !Array.isArray(plans) ||
        plans.length === 0 ||
        !plans.every((p) => (PLANS as readonly unknown[]).includes(p))
      ) {
        return bad('plans', `must list plans among ${PLANS.join(', ')}`);
      }
      return { type: 'plans', plans: [...new Set(plans as Plan[])] };
    }
    case 'workspaces': {
      const ids = rule['workspaces'];
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > MAX_RULE_WORKSPACES ||
        !ids.every((id) => isId('wsp', id))
      ) {
        return bad('workspaces', `must list 1 to ${MAX_RULE_WORKSPACES} wsp_ ids`);
      }
      return { type: 'workspaces', workspaces: [...new Set(ids as string[])] };
    }
    case 'client_version': {
      const { min, max } = rule;
      if (min === undefined && max === undefined) return bad('min', 'min or max is required');
      const minV = min === undefined ? null : typeof min === 'string' ? parseSemver(min) : null;
      const maxV = max === undefined ? null : typeof max === 'string' ? parseSemver(max) : null;
      if (min !== undefined && minV === null) return bad('min', 'must be a semantic version');
      if (max !== undefined && maxV === null) return bad('max', 'must be a semantic version');
      return {
        type: 'client_version',
        ...(min === undefined ? {} : { min: min as string }),
        ...(max === undefined ? {} : { max: max as string }),
      };
    }
    default:
      issues.push({
        pointer: `${pointer}/type`,
        code: 'invalid_value',
        detail: 'must be percent, plans, workspaces or client_version',
      });
      return null;
  }
}

/**
 * `input` as a complete definition, checked: key pattern and denylist, types, value sizes
 * (`limits.maxValueBytes` each, as compact JSON), no secret-like strings, known rules. A 422 lists
 * every problem.
 */
export function checkFlagDef(input: unknown, limits: FlagLimits): Required<FlagDef> {
  const issues: FieldError[] = [];
  if (!isRecord(input)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const key = input['key'];
  if (typeof key !== 'string' || !FLAG_KEY.test(key)) {
    issues.push({
      pointer: '/key',
      code: 'invalid_format',
      detail: 'must match [a-z0-9_.-]{1,64}',
    });
  } else if (
    key.split(/[._-]/).some((segment) => DENIED_KEY_SEGMENTS.has(segment)) ||
    key === '__proto__'
  ) {
    issues.push({
      pointer: '/key',
      code: 'not_allowed',
      detail: 'must not name a secret, a token, a key or a credential',
    });
  }
  const type = input['type'];
  if (typeof type !== 'string' || !TYPES.has(type)) {
    issues.push({
      pointer: '/type',
      code: 'invalid_value',
      detail: 'must be bool, string, number or json',
    });
  } else {
    checkValue(type as FlagType, input['value'], '/value', limits, issues);
    checkValue(type as FlagType, input['default'], '/default', limits, issues);
  }
  const flags: Record<string, boolean> = {};
  for (const name of ['public', 'server_only', 'kill'] as const) {
    const v = input[name];
    if (v !== undefined && typeof v !== 'boolean') {
      issues.push({ pointer: `/${name}`, code: 'invalid_type', detail: 'must be a boolean' });
    }
    flags[name] = v === true;
  }
  if (flags['public'] === true && flags['server_only'] === true) {
    issues.push({
      pointer: '/public',
      code: 'not_allowed',
      detail: 'a server_only flag cannot be public',
    });
  }
  const rawRules = input['rules'] ?? [];
  const rules: FlagRule[] = [];
  if (!Array.isArray(rawRules) || rawRules.length > MAX_RULES) {
    issues.push({
      pointer: '/rules',
      code: 'invalid_type',
      detail: `must be at most ${MAX_RULES} rules`,
    });
  } else {
    const seen = new Set<string>();
    rawRules.forEach((raw, i) => {
      const rule = checkRule(raw, `/rules/${i}`, issues);
      if (rule === null) return;
      if (seen.has(rule.type)) {
        issues.push({ pointer: `/rules/${i}/type`, code: 'not_allowed', detail: 'is given twice' });
      }
      seen.add(rule.type);
      rules.push(rule);
    });
  }
  if (issues.length > 0) throw validationFailed(issues, DEFINITION_DETAILS.invalid);
  return {
    key: key as string,
    type: type as FlagType,
    value: input['value'] as FlagValue,
    default: input['default'] as FlagValue,
    public: flags['public'] === true,
    server_only: flags['server_only'] === true,
    kill: flags['kill'] === true,
    rules,
  };
}

/** A stored row, as the repository reads it. */
export interface FlagRow {
  key: string;
  type: string;
  value: unknown;
  default_value: unknown;
  public: boolean;
  server_only: boolean;
  kill: boolean;
  rules: unknown;
}

/**
 * A stored flag ready to evaluate. Never throws: a rule this code does not understand (an unknown
 * type, a bad field) marks the flag `broken`, and it serves its default.
 */
export function readStoredFlag(row: FlagRow): EvalFlag {
  const flag: EvalFlag = {
    key: row.key,
    value: row.value as FlagValue,
    default: row.default_value as FlagValue,
    public: row.public,
    serverOnly: row.server_only,
    kill: row.kill,
    basisPoints: null,
    plans: null,
    workspaces: null,
    version: null,
    broken: false,
  };
  const rules = Array.isArray(row.rules) ? row.rules : null;
  if (rules === null) return { ...flag, broken: true };
  const issues: FieldError[] = [];
  for (const raw of rules) {
    const rule = checkRule(raw, '', issues);
    if (rule === null) return { ...flag, broken: true };
    if (rule.type === 'percent') flag.basisPoints = Math.round(rule.percent * 100);
    else if (rule.type === 'plans') flag.plans = new Set(rule.plans);
    else if (rule.type === 'workspaces') flag.workspaces = new Set(rule.workspaces);
    else {
      flag.version = {
        min: rule.min === undefined ? null : parseSemver(rule.min),
        max: rule.max === undefined ? null : parseSemver(rule.max),
      };
    }
  }
  return flag;
}
