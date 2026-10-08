/**
 * Relay metrics (B037): what the relay counts, under fixed names and labels from small fixed sets
 * (a frame type, a close code), never a session, member or user id:
 *
 * - `relay_connections_active`: open connections. The Metrics interface has no gauge, so it is
 *   read when scraped (`gauges()`), as the DB pool's are (B093 exports both);
 * - `relay_connections_total`: connections accepted;
 * - `relay_frames_in_total{t}`: frames received, by envelope type (`invalid` when not one,
 *   `binary` for binary messages);
 * - `relay_closes_total{code}`: closes, by code (`other` when not a known one);
 * - `relay_handler_errors_total`: a connection handler threw;
 * - `relay_upgrades_refused_total{reason}`: upgrades answered with an HTTP error.
 *
 * Owns: the names and the label rules.
 */
import type { Metrics } from '@centcom/core';
import { CloseCode } from './close-codes.js';

/** The metric names. */
export const RELAY_METRICS = Object.freeze({
  connectionsActive: 'relay_connections_active',
  connectionsTotal: 'relay_connections_total',
  framesIn: 'relay_frames_in_total',
  closes: 'relay_closes_total',
  handlerErrors: 'relay_handler_errors_total',
  upgradesRefused: 'relay_upgrades_refused_total',
} as const);

/** Envelope frame types (CT-WS-ENVELOPE `t`): the values `relay_frames_in_total{t}` takes. */
export const FRAME_TYPES: readonly string[] = Object.freeze([
  'sys.hello',
  'sys.welcome',
  'sys.ping',
  'sys.pong',
  'sys.error',
  'sys.slow_down',
  'sys.notice',
  'sys.resume',
  'sys.resumed',
  'sys.bye',
  'event',
  'queue',
  'control',
  'presence',
  'ack',
]);

/** Why an upgrade was refused (`relay_upgrades_refused_total{reason}`). */
export type UpgradeRefusal =
  'path' | 'query_credentials' | 'origin' | 'subprotocol' | 'draining' | 'bad_request';

/** Close codes `relay_closes_total{code}` names: the table's, plus 1005 (none) and 1006 (abnormal). */
const CLOSE_LABELS: ReadonlySet<number> = new Set([...Object.values(CloseCode), 1005, 1006]);

/** The `t` label of a received message: its envelope type, `invalid` or `binary`. */
export function frameLabel(data: string | null): string {
  if (data === null) return 'binary';
  // Only the type is wanted: a cheap probe, not validation (B039 validates frames).
  try {
    const t = (JSON.parse(data) as { t?: unknown } | null)?.t;
    return typeof t === 'string' && FRAME_TYPES.includes(t) ? t : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** The `code` label of a close. */
export const closeLabel = (code: number): string =>
  CLOSE_LABELS.has(code) ? String(code) : 'other';

/** The relay's recorders. */
export interface RelayMetrics {
  connectionOpened(): void;
  frameIn(t: string): void;
  closed(code: number): void;
  handlerError(): void;
  upgradeRefused(reason: UpgradeRefusal): void;
}

/** Recorders over `metrics`. */
export function createRelayMetrics(metrics: Metrics): RelayMetrics {
  return {
    connectionOpened: () => metrics.counter(RELAY_METRICS.connectionsTotal).inc(),
    frameIn: (t) => metrics.counter(RELAY_METRICS.framesIn, { t }).inc(),
    closed: (code) => metrics.counter(RELAY_METRICS.closes, { code: closeLabel(code) }).inc(),
    handlerError: () => metrics.counter(RELAY_METRICS.handlerErrors).inc(),
    upgradeRefused: (reason) => metrics.counter(RELAY_METRICS.upgradesRefused, { reason }).inc(),
  };
}
