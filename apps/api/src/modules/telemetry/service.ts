/**
 * Telemetry ingest (B085, CT-TELEMETRY): what `POST /v1/telemetry/events` does with a body, which
 * is always answered 204 whatever happens here (rule 4).
 *
 * 1. The address's limit (120 batches a minute) is checked before the body is even parsed, so a
 *    flood costs as little as possible.
 * 2. The body must be `application/json`, at most TELEMETRY_BATCH_MAX_BYTES, and JSON.
 * 3. The install's limit (12 batches a minute) is checked once its `install_id` is known.
 * 4. `scrubBatch` keeps the allow-listed events and props only.
 * 5. The kept events are written in one statement, partitioned by the UTC day received.
 *
 * Every dropped event is counted in `telemetry_dropped_total{reason}` (`schema`, `too_large`,
 * `type_unknown`, `pii_pattern`, `enum_unknown`, `rate_limited`, `store_error`), every stored one
 * in `telemetry_accepted_total`. Nothing about the caller is stored or logged: not the principal,
 * not the address, not the request id, not the body.
 *
 * Owns: the order of the steps. Must not: throw, or look up who the caller is.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import type { TelemetryConfig } from './config.js';
import type { TelemetryLimits } from './limits.js';
import { dayOf, type TelemetryRepository } from './repository.js';
import { scrubBatch, type DropReason } from './scrub.js';

/** A request as ingest sees it. */
export interface TelemetryRequest {
  /** The raw body, unparsed; undefined when there was none. */
  body: Buffer | undefined;
  contentType: string | undefined;
  /** The client's address, for the rate limit only. */
  ip: string;
}

/** What happened to a batch (for tests; the client never sees it). */
export interface IngestOutcome {
  stored: number;
  dropped: Partial<Record<DropReason, number>>;
}

/** What ingest needs. */
export interface TelemetryIngestDeps {
  repository: Pick<TelemetryRepository, 'insert'>;
  limits: Pick<TelemetryLimits, 'address' | 'install'>;
  config: Pick<TelemetryConfig, 'maxEvents' | 'maxBytes' | 'retentionDays'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

/** Takes telemetry batches. */
export class TelemetryIngest {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: TelemetryIngestDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Takes one request; never throws. */
  async ingest(request: TelemetryRequest): Promise<IngestOutcome> {
    const outcome: IngestOutcome = { stored: 0, dropped: {} };
    const drop = (reason: DropReason, count: number) => {
      if (count <= 0) return;
      outcome.dropped[reason] = (outcome.dropped[reason] ?? 0) + count;
      this.#metrics.counter('telemetry_dropped_total', { reason }).inc(count);
    };
    try {
      const now = this.#clock();
      if (!(await this.deps.limits.address(request.ip, now))) {
        drop('rate_limited', 1);
        return outcome;
      }
      const { body } = request;
      if (body === undefined || body.length === 0 || !JSON_TYPE.test(request.contentType ?? '')) {
        drop('schema', 1);
        return outcome;
      }
      if (body.length > this.deps.config.maxBytes) {
        drop('too_large', 1);
        return outcome;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        drop('schema', 1);
        return outcome;
      }
      const scrubbed = scrubBatch(parsed, {
        maxEvents: this.deps.config.maxEvents,
        retentionDays: this.deps.config.retentionDays,
        now: new Date(now),
      });
      if (scrubbed.installId !== null && !(await this.deps.limits.install(scrubbed.installId))) {
        drop(
          'rate_limited',
          scrubbed.accepted.length + scrubbed.dropped.reduce((n, d) => n + d.count, 0),
        );
        return outcome;
      }
      for (const { reason, count } of scrubbed.dropped) drop(reason, count);
      if (scrubbed.fieldsDropped > 0) {
        this.#metrics.counter('telemetry_fields_dropped_total').inc(scrubbed.fieldsDropped);
      }
      if (scrubbed.accepted.length === 0) return outcome;
      try {
        await this.deps.repository.insert(dayOf(new Date(now)), scrubbed.accepted);
      } catch (err) {
        drop('store_error', scrubbed.accepted.length);
        this.deps.logger?.warn({ error: (err as Error).name }, 'telemetry.store_failed');
        return outcome;
      }
      outcome.stored = scrubbed.accepted.length;
      this.#metrics.counter('telemetry_accepted_total').inc(outcome.stored);
      return outcome;
    } catch (err) {
      // Nothing gets out: the client is answered 204 whatever happened.
      drop('store_error', 1);
      this.deps.logger?.error({ error: (err as Error).name }, 'telemetry.ingest_failed');
      return outcome;
    }
  }
}
