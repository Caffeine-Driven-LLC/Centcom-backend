/**
 * What telemetry may carry (B093 guardrails), applied in the service before anything is exported
 * and again by the collector (infra/observability/collector):
 *
 * - span attributes named `authorization`, `cookie`, `set-cookie`, `ct`, `p`, `ticket`, `token`,
 *   or holding a password, secret or API key, and the client's address, are dropped;
 * - string values have CT-IDS ids of users, workspaces, sessions, members, devices and the like
 *   replaced (request ids stay: they are how a trace is linked to logs), and e-mail and IP
 *   addresses, bearer tokens and JWTs removed;
 * - a metric label value that holds any of those is not used at all (`redacted`).
 *
 * Owns: the rules. Must not: let an attribute through because its value looks harmless.
 */
import type { AttributeValue, Attributes } from '@opentelemetry/api';

/** Attribute names that are never exported (compared in lower case, by their last segment too). */
const DROPPED_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'ct',
  'p',
  'ticket',
  'token',
  'x-admin-ticket',
  'x-admin-reason',
]);
/** Attribute names holding the client's address. */
const CLIENT_ADDRESS: ReadonlySet<string> = new Set([
  'client.address',
  'client.ip',
  'client.port',
  'http.client_ip',
  'net.peer.ip',
  'net.peer.port',
  'net.sock.peer.addr',
  'network.peer.address',
  'network.peer.port',
  'source.address',
  'user_agent.original',
  'http.user_agent',
]);
const SECRET_NAME =
  /(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;

/** CT-IDS ids that identify people, places or content (request ids `req_` are allowed). */
const ENTITY_ID =
  /\b(usr|ses|wsp|agt|dev|que|mem|msg|inv|apr|key|sub|whk|dlv|ntf|aud|snp|prj|blb|exp|psh|use|inc)_[0-9A-HJKMNP-TV-Z]{26}\b/g;
const EMAIL = /[^\s@<>"'(),;:[\]]+@[^\s@<>"'(),;:[\]]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Full IPv6 addresses, and compressed ones (`fe80::1`, `::1`). */
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?=[^0-9a-z:]|$)/gi;
const BEARER = /\bBearer\s+\S+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const API_KEY = /\bcen_(?:live|test)_[A-Za-z0-9]+/g;

/** True when an attribute named `name` must never be exported. */
export function isDroppedAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  const last = lower.slice(lower.lastIndexOf('.') + 1);
  return (
    DROPPED_NAMES.has(lower) ||
    DROPPED_NAMES.has(last) ||
    CLIENT_ADDRESS.has(lower) ||
    SECRET_NAME.test(lower)
  );
}

/** `text` without ids of entities, addresses or credentials. */
export function redactTelemetryText(text: string): string {
  return text
    .replace(JWT, '[redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(API_KEY, '[redacted]')
    .replace(EMAIL, '[email]')
    .replace(ENTITY_ID, '$1_[id]')
    .replace(IPV4, '[ip]')
    .replace(IPV6, '[ip]');
}

function redactValue(value: AttributeValue): AttributeValue {
  if (typeof value === 'string') return redactTelemetryText(value);
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? redactTelemetryText(v) : v)) as AttributeValue;
  }
  return value;
}

/** A copy of `attributes` fit to export (see the module comment). */
export function redactAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || isDroppedAttribute(name)) continue;
    out[name] = redactValue(value);
  }
  return out;
}

/** True when a metric label value could identify someone or something (and so is not used). */
export function isUnsafeLabelValue(value: string): boolean {
  return value.length > 100 || redactTelemetryText(value) !== value || value.includes('?');
}
