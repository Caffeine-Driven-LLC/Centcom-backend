/**
 * Telemetry scrubbing (B085, CT-TELEMETRY, `contracts/schemas/telemetry.schema.json`): what of a
 * batch may be stored. The allow-list is closed: anything it does not name is dropped.
 *
 * - **Batch:** an object with `install_id`, a ULID (CT-IDS without a prefix), and 1 to
 *   TELEMETRY_BATCH_MAX_EVENTS `events`; otherwise every event is dropped (`schema`, or
 *   `too_large` past the count). `app` and any other top-level field are never stored.
 * - **Event:** an allow-listed `type` (else `type_unknown`), an RFC 3339 `at` within the retention
 *   window and at most 10 minutes ahead (else `schema`), and `props` (at most 8). Other fields of
 *   an event are dropped; the event stays.
 * - **Props:** only the type's own keys are kept (others dropped, the event stays). Each value is
 *   checked as strictly as its key allows:
 *   - free strings (`command.run.name`, `feature.used.key`, `session.created.mode`) must be short
 *     lower-case words: anything with `/`, `\`, `@`, a URL scheme, an address, a host name, a
 *     branch-like or a path-like shape, or over 64 characters is `pii_pattern`;
 *   - agent states must be `state-map.json` keys, error codes CT-ERR codes, transports `relay` or
 *     `lan` (else `enum_unknown`);
 *   - versions SemVer, numbers within their range, flags booleans (else `schema`).
 *
 * Owns: the allow-list and its patterns. Must not: keep a value it cannot classify as safe.
 */
import { ERRORS, PRODUCT_STATES } from '@centcom/contracts';
import { parseSemver } from '../flags/version.js';

/** The event types (CT-TELEMETRY v1). */
export const EVENT_TYPES = Object.freeze([
  'app.start',
  'app.exit',
  'command.run',
  'session.created',
  'session.joined',
  'agent.state_change',
  'feature.used',
  'error.shown',
  'perf.startup',
  'perf.frame',
  'update.result',
] as const);
export type EventType = (typeof EVENT_TYPES)[number];

/** Why events were dropped (`telemetry_dropped_total{reason}`). */
export type DropReason =
  | 'type_unknown'
  | 'schema'
  | 'pii_pattern'
  | 'enum_unknown'
  | 'too_large'
  | 'rate_limited'
  | 'store_error';

/** A prop value as stored. */
export type PropValue = string | number | boolean;

/** An event as stored: no user, device, workspace, address or request. */
export interface StoredEvent {
  install_id: string;
  type: EventType;
  at: Date;
  props: Record<string, PropValue>;
}

/** What a batch came to. */
export interface ScrubResult {
  /** The batch's install id, when it had a valid one. */
  installId: string | null;
  accepted: StoredEvent[];
  dropped: { reason: DropReason; count: number }[];
  /** Props and fields left out of accepted events. */
  fieldsDropped: number;
}

/** Limits of a scrub. */
export interface ScrubOptions {
  maxEvents: number;
  retentionDays: number;
  now: Date;
}

/** CT-IDS ULID without a prefix: 26 Crockford characters, the time part within 48 bits. */
export const INSTALL_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** How far ahead of the server's clock an event may be. */
export const MAX_FUTURE_MS = 10 * 60 * 1000;
/** Props one event may carry (the schema's maxProperties). */
export const MAX_PROPS = 8;
/** The longest string value. */
export const MAX_STRING = 64;

type Kind =
  | { kind: 'command' }
  | { kind: 'feature' }
  | { kind: 'token' }
  | { kind: 'state' }
  | { kind: 'error_code' }
  | { kind: 'transport' }
  | { kind: 'semver' }
  | { kind: 'number'; max: number }
  | { kind: 'boolean' };

/** Each type's props and how they are checked. */
const PROPS: Readonly<Record<EventType, Readonly<Record<string, Kind>>>> = {
  'app.start': {},
  'app.exit': {},
  'command.run': { name: { kind: 'command' } },
  'session.created': { mode: { kind: 'token' }, transport: { kind: 'transport' } },
  'session.joined': { transport: { kind: 'transport' } },
  'agent.state_change': { from: { kind: 'state' }, to: { kind: 'state' } },
  'feature.used': { key: { kind: 'feature' } },
  'error.shown': { code: { kind: 'error_code' } },
  'perf.startup': { ms: { kind: 'number', max: 10 * 60 * 1000 } },
  'perf.frame': { p95_ms: { kind: 'number', max: 60 * 1000 } },
  'update.result': { from: { kind: 'semver' }, to: { kind: 'semver' }, ok: { kind: 'boolean' } },
};

const STATES: ReadonlySet<string> = new Set(PRODUCT_STATES);
const ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(ERRORS));
const TRANSPORTS: ReadonlySet<string> = new Set(['relay', 'lan']);
const TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * Shapes that are never telemetry: paths, URLs, addresses, e-mails, host names, git refs. Branch
 * names are caught by their `/` (`feature/login`) or git syntax; a bare word cannot be told from a
 * command name, which is why free strings must also match their key's narrow pattern.
 */
const PII_SHAPES: readonly RegExp[] = [
  /[/\\@~]/,
  /^[a-z][a-z0-9+.-]*:/i, // a URL or URI scheme (`https:`, `file:`, `mailto:`)
  /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?![0-9])/, // IPv4
  /[0-9a-f]{1,4}:[0-9a-f]{0,4}:/i, // IPv6
  /\.(?:com|net|org|io|dev|app|ai|co|cloud|local|internal|lan|corp|home|sh|me|gg|xyz|tech|edu|gov)$/i, // a host name
  /^(?:refs|heads|origin|remotes)(?:[._-]|$)|\.git$|\.\.|\.lock$/i, // git refs and branch syntax
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  /[\u0000-\u001f\u007f]/,
];
const COMMAND = /^[a-z][a-z0-9_-]{0,31}(?: [a-z][a-z0-9_-]{0,31}){0,3}$/;
const FEATURE = /^[a-z][a-z0-9_-]{0,31}(?:\.[a-z][a-z0-9_-]{0,31}){0,3}$/;
const TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when a free string could carry personal or work data. */
export function looksLikePii(value: string): boolean {
  return value.length > MAX_STRING || PII_SHAPES.some((shape) => shape.test(value));
}

/** The value to store, or why the event is dropped. */
function checkValue(kind: Kind, value: unknown): { ok: PropValue } | { drop: DropReason } {
  switch (kind.kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= kind.max
        ? { ok: value }
        : { drop: 'schema' };
    case 'boolean':
      return typeof value === 'boolean' ? { ok: value } : { drop: 'schema' };
    default:
      break;
  }
  if (typeof value !== 'string') return { drop: 'schema' };
  switch (kind.kind) {
    case 'command':
    case 'feature':
    case 'token': {
      if (looksLikePii(value)) return { drop: 'pii_pattern' };
      const shape = kind.kind === 'command' ? COMMAND : kind.kind === 'feature' ? FEATURE : TOKEN;
      return shape.test(value) ? { ok: value } : { drop: 'pii_pattern' };
    }
    case 'state':
      return STATES.has(value) ? { ok: value } : { drop: 'enum_unknown' };
    case 'error_code':
      return ERROR_CODES.has(value) ? { ok: value } : { drop: 'enum_unknown' };
    case 'transport':
      return TRANSPORTS.has(value) ? { ok: value } : { drop: 'enum_unknown' };
    case 'semver':
      return value.length <= MAX_STRING && parseSemver(value) !== null
        ? { ok: value }
        : { drop: 'schema' };
  }
}

/** One event as stored, or why it is dropped; `fields` counts what was left out. */
function scrubEvent(
  raw: unknown,
  installId: string,
  opts: ScrubOptions,
  fields: { dropped: number },
): StoredEvent | DropReason {
  if (!isRecord(raw)) return 'schema';
  const type = raw['type'];
  if (typeof type !== 'string' || !TYPES.has(type)) return 'type_unknown';
  const at = raw['at'];
  const time = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) ? Date.parse(at) : NaN;
  const now = opts.now.getTime();
  if (
    Number.isNaN(time) ||
    time < now - opts.retentionDays * 86_400_000 ||
    time > now + MAX_FUTURE_MS
  ) {
    return 'schema';
  }
  fields.dropped += Object.keys(raw).filter(
    (k) => k !== 'type' && k !== 'at' && k !== 'props',
  ).length;
  const rawProps = raw['props'] ?? {};
  if (!isRecord(rawProps) || Object.keys(rawProps).length > MAX_PROPS) return 'schema';
  const allowed = PROPS[type as EventType];
  const props: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(rawProps)) {
    const kind = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    if (kind === undefined) {
      fields.dropped += 1;
      continue;
    }
    const checked = checkValue(kind, value);
    if ('drop' in checked) return checked.drop;
    props[key] = checked.ok;
  }
  return { install_id: installId, type: type as EventType, at: new Date(time), props };
}

/**
 * What of `input` (a parsed batch) may be stored, and why the rest was dropped. `options` default
 * to 100 events, 90 days and the current time.
 */
export function scrubBatch(input: unknown, options: Partial<ScrubOptions> = {}): ScrubResult {
  const opts: ScrubOptions = {
    maxEvents: options.maxEvents ?? 100,
    retentionDays: options.retentionDays ?? 90,
    now: options.now ?? new Date(),
  };
  const counts = new Map<DropReason, number>();
  const drop = (reason: DropReason, count: number) => {
    if (count > 0) counts.set(reason, (counts.get(reason) ?? 0) + count);
  };
  const result = (
    installId: string | null,
    accepted: StoredEvent[],
    fieldsDropped = 0,
  ): ScrubResult => ({
    installId,
    accepted,
    dropped: [...counts].map(([reason, count]) => ({ reason, count })),
    fieldsDropped,
  });
  const events = isRecord(input) ? input['events'] : undefined;
  const eventCount = Array.isArray(events) ? Math.max(events.length, 1) : 1;
  if (!isRecord(input) || !Array.isArray(events) || events.length === 0) {
    drop('schema', eventCount);
    return result(null, []);
  }
  const installId = input['install_id'];
  if (typeof installId !== 'string' || !INSTALL_ID.test(installId)) {
    drop('schema', eventCount);
    return result(null, []);
  }
  if (events.length > opts.maxEvents) {
    drop('too_large', events.length);
    return result(installId, []);
  }
  const fields = {
    dropped: Object.keys(input).filter((k) => k !== 'install_id' && k !== 'events' && k !== 'app')
      .length,
  };
  const accepted: StoredEvent[] = [];
  for (const raw of events) {
    const scrubbed = scrubEvent(raw, installId, opts, fields);
    if (typeof scrubbed === 'string') drop(scrubbed, 1);
    else accepted.push(scrubbed);
  }
  return result(installId, accepted, fields.dropped);
}
