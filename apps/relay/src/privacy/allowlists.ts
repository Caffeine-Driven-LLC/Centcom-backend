/**
 * What the relay may write about a frame (B050, CT-CRYPTO "What the server stores", GUIDELINES
 * §3.7): deny by default. Adding a log field or a metric label is a reviewed change to this file
 * (a test fails while the relay's source uses one that is not here).
 *
 * - **Log fields:** the card's (`request_id`, `sid`, `mid`, `dev`, `kind`, `t`, `seq`, `size`, `kid`,
 *   `code`, `state`) and the relay's operational ones: counts, codes, reasons, seq ranges, error
 *   class names, process facts. Never `ct`, `p`, `c`, `n`, `sig`, `ticket`, `text`, `path` or
 *   anything else.
 * - **Metric labels:** those B093's catalogue declares for relay metrics (each reviewed there), never
 *   one CT-otel forbids (ids, addresses, content: `FORBIDDEN_LABEL`).
 *
 * Owns: the lists. Must not: allow a field that can hold frame content.
 */
import { FORBIDDEN_LABEL, METRICS } from '@centcom/core';

/** Log fields the card allows. */
export const CARD_LOG_FIELDS = [
  'request_id',
  'sid',
  'mid',
  'dev',
  'kind',
  't',
  'seq',
  'size',
  'kid',
  'code',
  'state',
] as const;

/** The relay's operational log fields (numbers, codes, names; never content). */
export const OPERATIONAL_LOG_FIELDS = [
  'attempts',
  'close',
  'connections',
  'contract_version',
  'count',
  'drain_ms',
  'epoch',
  'error',
  'frames',
  'from_seq',
  'gap',
  'head',
  'held',
  'max',
  'member',
  'mode',
  'module',
  'node',
  'order',
  'overloaded',
  'port',
  'ready',
  'reason',
  'region',
  'result',
  'retry_in_ms',
  'signal',
  'silent_ms',
  'status',
  'to_seq',
  'total',
  'version',
] as const;

/** Every field a relay log line may carry. */
export const LOG_FIELDS: ReadonlySet<string> = new Set<string>([
  ...CARD_LOG_FIELDS,
  ...OPERATIONAL_LOG_FIELDS,
]);

/** Fields that can never be allowed (frame content, secrets). */
export const NEVER_LOGGED: ReadonlySet<string> = new Set([
  'ct',
  'p',
  'c',
  'n',
  'sig',
  'ticket',
  'text',
  'path',
  'frame',
  'payload',
  'body',
  'secret',
]);

/** Every label a relay metric may carry: the catalogue's, for metrics the relay emits. */
export const METRIC_LABELS: ReadonlySet<string> = new Set(
  Object.values(METRICS)
    .filter((def) => def.services.includes('relay'))
    .flatMap((def) => [...def.labels])
    .filter((label) => !FORBIDDEN_LABEL.test(label)),
);
