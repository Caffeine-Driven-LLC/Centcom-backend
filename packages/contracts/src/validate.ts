/**
 * Validator facade (B003): typed access to the precompiled validators generated from contracts/.
 *
 * Owns: the Result shape, mapping Ajv errors to `{pointer, code, detail}` issues, strict versus
 * tolerant validation, and the frame / event payload helpers.
 * Must not: compile schemas at runtime, throw on any input, or mutate the value it validates.
 */
import { VALIDATORS, type AjvErrorObject, type RawValidator } from '#generated/validators';
import {
  EVENT_CATALOGUE,
  type Entitlements,
  type Envelope,
  type EventKind,
  type EventPayloads,
  type EventSecrets,
  type LanPair,
  type Notification,
  type Problem,
  type ProviderPolicy,
  type ReleaseManifest,
  type SchemaKey,
  type SchemaTypes,
  type Telemetry,
  type Webhook,
} from './generated/types.js';

/**
 * Stable codes for a single validation issue (the `code` of a problem+json `errors[]` entry).
 * `unknown_schema`, `unknown_kind` and `internal` describe the call rather than the data.
 */
export type IssueCode =
  | 'required'
  | 'invalid_type'
  | 'invalid_value'
  | 'invalid_format'
  | 'out_of_range'
  | 'too_short'
  | 'too_long'
  | 'too_few'
  | 'too_many'
  | 'not_allowed'
  | 'no_match'
  | 'invalid'
  | 'unknown_schema'
  | 'unknown_kind'
  | 'internal';

/** One problem with a value: a JSON Pointer (RFC 6901) into it, a stable code, English detail. */
export interface ValidationIssue {
  pointer: string;
  code: IssueCode;
  detail: string;
}

/** Outcome of a validation or parse: the typed value, or the issues found. Never thrown. */
export type Result<T> = { ok: true; value: T } | { ok: false; errors: ValidationIssue[] };

/**
 * `strict` validates exactly what the schema says (use it for input you act on and for anything
 * you write). `tolerant` also accepts unknown values of enums the contract documents as
 * extensible (CT-VER robustness rule), for reading data a newer peer may have produced.
 */
export type ValidationMode = 'strict' | 'tolerant';

/** Options for `validate()` and the helpers built on it. */
export interface ValidateOptions {
  mode?: ValidationMode;
}

const CODES: Readonly<Record<string, IssueCode>> = {
  required: 'required',
  type: 'invalid_type',
  const: 'invalid_value',
  enum: 'invalid_value',
  pattern: 'invalid_format',
  format: 'invalid_format',
  minimum: 'out_of_range',
  maximum: 'out_of_range',
  exclusiveMinimum: 'out_of_range',
  exclusiveMaximum: 'out_of_range',
  multipleOf: 'out_of_range',
  minLength: 'too_short',
  maxLength: 'too_long',
  minItems: 'too_few',
  minProperties: 'too_few',
  maxItems: 'too_many',
  maxProperties: 'too_many',
  additionalProperties: 'not_allowed',
  not: 'not_allowed',
  'false schema': 'not_allowed',
  oneOf: 'no_match',
  anyOf: 'no_match',
  discriminator: 'no_match',
};

/** Ajv reports these alongside the real cause; they add nothing for a caller. */
const WRAPPER_KEYWORDS = new Set(['if', 'allOf', '$ref']);

const escapeToken = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

const failure = (pointer: string, code: IssueCode, detail: string): { ok: false; errors: ValidationIssue[] } => ({
  ok: false,
  errors: [{ pointer, code, detail }],
});

function toIssue(e: AjvErrorObject): ValidationIssue {
  let pointer = e.instancePath;
  const missing = e.params.missingProperty;
  const extra = e.params.additionalProperty;
  if (e.keyword === 'required' && typeof missing === 'string') pointer += `/${escapeToken(missing)}`;
  if (e.keyword === 'additionalProperties' && typeof extra === 'string') pointer += `/${escapeToken(extra)}`;
  const detail =
    e.keyword === 'required' ? 'is required' : e.keyword === 'additionalProperties' ? 'is not allowed here' : (e.message ?? 'is invalid');
  return { pointer, code: CODES[e.keyword] ?? 'invalid', detail };
}

function issuesFrom(errors: AjvErrorObject[] | null | undefined): ValidationIssue[] {
  const all = errors ?? [];
  const meaningful = all.filter((e) => !WRAPPER_KEYWORDS.has(e.keyword));
  const issues = (meaningful.length > 0 ? meaningful : all).map(toIssue);
  return issues.length > 0 ? issues : [{ pointer: '', code: 'invalid', detail: 'is invalid' }];
}

function run(validator: RawValidator, value: unknown): Result<unknown> {
  try {
    return validator(value) ? { ok: true, value } : { ok: false, errors: issuesFrom(validator.errors) };
  } catch {
    // Generated validators do not throw on JSON input; this guards exotic values (proxies, getters).
    return failure('', 'internal', 'the value could not be validated');
  }
}

/**
 * Validates `value` against one contract schema. Keys: a schema file stem (`envelope`, `events`,
 * `entitlements`, ...), `event/<kind>` (cleartext payload), `event-secret/<kind>` (secret payload)
 * or `api/<Name>` (an OpenAPI component). The value is returned as-is (never copied or coerced).
 */
export function validate<K extends SchemaKey>(
  key: K,
  value: unknown,
  options: ValidateOptions = {},
): Result<SchemaTypes[K]> {
  const validator = (options.mode === 'tolerant' ? VALIDATORS[`${key}#tolerant`] : undefined) ?? VALIDATORS[key];
  if (!validator) return failure('', 'unknown_schema', `no contract schema is named ${JSON.stringify(key)}`);
  return run(validator, value) as Result<SchemaTypes[K]>;
}

/** True if `kind` is in the event catalogue. */
export function isEventKind(kind: unknown): kind is EventKind {
  return typeof kind === 'string' && Object.hasOwn(EVENT_CATALOGUE, kind);
}

/**
 * Validates a WebSocket frame: envelope.schema.json, then events.schema.json (which checks the
 * payload mode and cleartext payload of known kinds). Unknown kinds pass, as CT-WS-SESSION-EVENTS
 * requires; a frame type (`t`) outside the envelope's list fails.
 */
export function validateEnvelope(value: unknown, options: ValidateOptions = {}): Result<Envelope> {
  const envelope = validate('envelope', value, options);
  if (!envelope.ok) return envelope;
  const events = validate('events', value, options);
  return events.ok ? envelope : events;
}

/** Cleartext payload type of a kind: its `p`, or `undefined` for encrypted kinds (no `p` allowed). */
export type ClearPayload<K extends EventKind> = K extends keyof EventPayloads ? EventPayloads[K] : undefined;

/**
 * Validates the cleartext payload `p` of an event of `kind`. Encrypted kinds carry no `p`, so only
 * `undefined` passes for them. An unknown kind yields `unknown_kind`, which readers should treat as
 * "ignore, but keep going" (CT-VER). Issue pointers are relative to the payload.
 */
export function validateEvent<K extends EventKind>(
  kind: K,
  payload: unknown,
  options: ValidateOptions = {},
): Result<ClearPayload<K>> {
  if (!isEventKind(kind)) return failure('', 'unknown_kind', `${JSON.stringify(kind)} is not in the event catalogue`);
  if (EVENT_CATALOGUE[kind].mode === 'encrypted') {
    return payload === undefined
      ? { ok: true, value: undefined as ClearPayload<K> }
      : failure('', 'not_allowed', `${kind} is encrypted and carries no cleartext payload`);
  }
  return validate(`event/${kind}` as SchemaKey, payload, options) as Result<ClearPayload<K>>;
}

/** Validates the decrypted secret payload (`ct` plaintext) of an event of `kind`. */
export function validateEventSecret<K extends keyof EventSecrets>(
  kind: K,
  secret: unknown,
  options: ValidateOptions = {},
): Result<EventSecrets[K]> {
  if (!isEventKind(kind)) return failure('', 'unknown_kind', `${JSON.stringify(kind)} is not in the event catalogue`);
  if (!EVENT_CATALOGUE[kind].secret) return failure('', 'not_allowed', `${kind} has no secret payload`);
  return validate(`event-secret/${kind}` as SchemaKey, secret, options) as Result<EventSecrets[K]>;
}

/** Entitlements document (CT-ENTITLEMENTS). */
export const validateEntitlements = (v: unknown, o?: ValidateOptions): Result<Entitlements> => validate('entitlements', v, o);
/** problem+json body or `sys.error` payload (CT-ERR). */
export const validateProblem = (v: unknown, o?: ValidateOptions): Result<Problem> => validate('problem', v, o);
/** Push notification payload (CT-NOTIF-PAYLOAD). */
export const validateNotification = (v: unknown, o?: ValidateOptions): Result<Notification> => validate('notification', v, o);
/** Outgoing webhook delivery payload (CT-WEBHOOKS). */
export const validateWebhook = (v: unknown, o?: ValidateOptions): Result<Webhook> => validate('webhook', v, o);
/** Telemetry batch (CT-TELEMETRY). */
export const validateTelemetry = (v: unknown, o?: ValidateOptions): Result<Telemetry> => validate('telemetry', v, o);
/** Release manifest (CT-API-RELEASES). */
export const validateReleaseManifest = (v: unknown, o?: ValidateOptions): Result<ReleaseManifest> =>
  validate('release-manifest', v, o);
/** LAN pairing frame (CT-LAN). */
export const validateLanPair = (v: unknown, o?: ValidateOptions): Result<LanPair> => validate('lan-pair', v, o);
/** Provider policy document (CT-PROVIDER). */
export const validateProviderPolicy = (v: unknown, o?: ValidateOptions): Result<ProviderPolicy> =>
  validate('provider-policy', v, o);
