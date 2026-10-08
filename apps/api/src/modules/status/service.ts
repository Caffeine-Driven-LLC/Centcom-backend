/**
 * The public status feed and its admin API (B086, CT-STATUS).
 *
 * `StatusFeed.current()` builds `GET /v1/status`:
 *
 * - `components`: STATUS_COMPONENTS with their probed status (`prober.ts`); `status` is the worst.
 * - `incidents`: open ones, and those resolved in the last 7 days, open first, newest first, each
 *   with its updates in order; at most 20.
 * - `min_client_version`: Redis `status:min_client_version` (the release service, B084), else
 *   MIN_CLIENT_VERSION; `contract_version`: the contracts this build was generated from
 *   (`contracts/index.json`); `deprecations`.
 * - At most 32 KiB: when larger, the oldest updates of the incidents with the most are left out
 *   (each keeps its newest).
 *
 * A built feed is reused for 15 s (with its ETag), so Postgres and Redis are read at most every
 * 15 s per instance, and `min_client_version` follows Redis within 15 s. When a build fails
 * (Postgres or Redis down), the last feed is served for up to 5 minutes, its `updated_at` showing
 * its age; after that, a feed of every component `degraded` plus a `status-data` component saying
 * the status data is unavailable. It never fails.
 *
 * `StatusAdmin` (for B087's tooling) creates incidents, adds updates, resolves them and sets
 * deprecations. Titles are at most 120 characters, update text at most 500, and neither may hold
 * an e-mail or IP address or a credential (CT-STATUS: no customer data).
 *
 * Owns: the feed's content and caching, and the admin rules. Must not: show a probe URL, a host, a
 * dependency's version or an error.
 */
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, newId } from '@centcom/contracts';
import {
  isSecretLike,
  noopMetrics,
  notFound,
  validationFailed,
  type FieldError,
  type KeyValue,
  type Logger,
  type Metrics,
} from '@centcom/core';
import type { IncidentStatus } from '@centcom/db';
import { MIN_CLIENT_VERSION_KEY } from '../releases/min-version.js';
import { worstOf, type ComponentStatus } from './aggregate.js';
import type { StatusComponent } from './config.js';
import type { ComponentReport } from './prober.js';
import type { DeprecationRecord, IncidentRecord, StatusRepository } from './repository.js';

/** Redis key of the minimum client version, written by the release service (B084). */
export { MIN_CLIENT_VERSION_KEY };
/** How long a built feed is reused. */
export const FEED_TTL_MS = 15_000;
/** How long the last feed is served while it cannot be rebuilt. */
export const FEED_STALE_MS = 5 * 60 * 1000;
/** Resolved incidents stay in the feed this long. */
export const RESOLVED_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Incidents in the feed, at most. */
export const MAX_FEED_INCIDENTS = 20;
/** The largest feed body. */
export const MAX_FEED_BYTES = 32 * 1024;
/** The synthetic component of a feed built without its data. */
export const STATUS_DATA_COMPONENT = Object.freeze({
  id: 'status-data',
  name: 'Status information',
});

/** CT-STATUS `GET /v1/status`. */
export interface StatusBody {
  status: ComponentStatus;
  updated_at: string;
  components: { id: string; name: string; status: ComponentStatus }[];
  incidents: {
    id: string;
    title: string;
    status: IncidentStatus;
    started_at: string;
    updates: { at: string; text: string }[];
  }[];
  min_client_version: string;
  contract_version: string;
  deprecations: { what: string; sunset: string }[];
}

/** A built feed: its bytes and their ETag. */
export interface FeedSnapshot {
  body: string;
  etag: string;
  builtAt: number;
}

/** What the feed needs. */
export interface StatusFeedDeps {
  prober: { statuses(): Promise<ComponentReport[]> };
  repository: Pick<StatusRepository, 'feedIncidents' | 'deprecations'>;
  kv: Pick<KeyValue, 'get'>;
  components: readonly StatusComponent[];
  /** MIN_CLIENT_VERSION. */
  minClientVersion: string;
  /** Default the generated CONTRACT_VERSION. */
  contractVersion?: string;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

const etagOf = (body: string): string =>
  `"s${createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, 22)}"`;

/** Leaves out the oldest updates (never an incident's newest) until the body fits. */
function fit(body: StatusBody): StatusBody {
  const size = () => Buffer.byteLength(JSON.stringify(body), 'utf8');
  while (size() > MAX_FEED_BYTES) {
    const longest = body.incidents.reduce<StatusBody['incidents'][number] | undefined>(
      (a, b) => (a === undefined || b.updates.length > a.updates.length ? b : a),
      undefined,
    );
    if (longest === undefined || longest.updates.length <= 1) break;
    longest.updates.shift();
  }
  return body;
}

/** Builds and caches the feed. */
export class StatusFeed {
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  #snapshot: FeedSnapshot | null = null;
  /** The last feed built from real data. */
  #lastGood: FeedSnapshot | null = null;
  #building: Promise<FeedSnapshot> | null = null;

  constructor(private readonly deps: StatusFeedDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** The feed to serve: never rejects. */
  current(): Promise<FeedSnapshot> {
    const snapshot = this.#snapshot;
    if (snapshot !== null && this.#clock() - snapshot.builtAt < FEED_TTL_MS) {
      return Promise.resolve(snapshot);
    }
    this.#building ??= this.#rebuild().finally(() => {
      this.#building = null;
    });
    return this.#building;
  }

  async #rebuild(): Promise<FeedSnapshot> {
    const now = this.#clock();
    try {
      const built = await this.#build(now);
      this.#snapshot = built;
      this.#lastGood = built;
      return built;
    } catch (err) {
      this.#metrics.counter('status_feed_build_failures_total').inc();
      this.deps.logger?.warn({ error: (err as Error).name }, 'status.feed_build_failed');
      const lastGood = this.#lastGood;
      if (lastGood !== null && now - lastGood.builtAt <= FEED_STALE_MS) return lastGood;
      // Too old to serve: every component degraded, and a marker saying why. Kept for 15 s.
      const fallback = this.#serialise(
        {
          status: 'degraded',
          updated_at: new Date(now).toISOString(),
          components: [
            ...this.deps.components.map((c) => ({
              id: c.id,
              name: c.name,
              status: 'degraded' as const,
            })),
            { ...STATUS_DATA_COMPONENT, status: 'degraded' },
          ],
          incidents: [],
          min_client_version: this.deps.minClientVersion,
          contract_version: this.deps.contractVersion ?? CONTRACT_VERSION,
          deprecations: [],
        },
        now,
      );
      this.#snapshot = fallback;
      return fallback;
    }
  }

  async #build(now: number): Promise<FeedSnapshot> {
    const [components, incidents, deprecations, minVersion] = await Promise.all([
      this.deps.prober.statuses(),
      this.deps.repository.feedIncidents(new Date(now - RESOLVED_SHOWN_MS), MAX_FEED_INCIDENTS),
      this.deps.repository.deprecations(),
      this.deps.kv.get(MIN_CLIENT_VERSION_KEY),
    ]);
    return this.#serialise(
      {
        status: worstOf(components.map((c) => c.status)),
        updated_at: new Date(now).toISOString(),
        components,
        incidents: incidents.map((i: IncidentRecord) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          started_at: i.startedAt.toISOString(),
          updates: i.updates.map((u) => ({ at: u.at.toISOString(), text: u.text })),
        })),
        min_client_version: minVersion ?? this.deps.minClientVersion,
        contract_version: this.deps.contractVersion ?? CONTRACT_VERSION,
        deprecations: deprecations.map((d: DeprecationRecord) => ({
          what: d.what,
          sunset: d.sunset,
        })),
      },
      now,
    );
  }

  #serialise(body: StatusBody, now: number): FeedSnapshot {
    const text = JSON.stringify(fit(body));
    return { body: text, etag: etagOf(text), builtAt: now };
  }
}

/** The details of refusals (GUIDELINES §3.4). */
export const STATUS_ADMIN_DETAILS = Object.freeze({
  invalid: 'The incident is not valid.',
  notFound: 'There is no such incident.',
} as const);

export const INCIDENT_STATUSES: readonly IncidentStatus[] = Object.freeze([
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);
export const MAX_TITLE = 120;
export const MAX_UPDATE_TEXT = 500;

/** A created or updated incident, as the feed shows it. */
export type Incident = StatusBody['incidents'][number] & {
  component_ids: string[];
  resolved_at: string | null;
};

const present = (i: IncidentRecord): Incident => ({
  id: i.id,
  title: i.title,
  status: i.status,
  started_at: i.startedAt.toISOString(),
  resolved_at: i.resolvedAt === null ? null : i.resolvedAt.toISOString(),
  component_ids: i.componentIds,
  updates: i.updates.map((u) => ({ at: u.at.toISOString(), text: u.text })),
});

/** What the admin API needs. */
export interface StatusAdminDeps {
  repository: StatusRepository;
  components: readonly StatusComponent[];
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** Incidents and deprecations, for B087's admin tooling (no HTTP route here). */
export class StatusAdmin {
  readonly #clock: () => number;

  constructor(private readonly deps: StatusAdminDeps) {
    this.#clock = deps.clock ?? Date.now;
  }

  /** Opens an incident (`inc_` id) on known components. */
  async createIncident(input: {
    title: string;
    component_ids: string[];
    status: IncidentStatus;
  }): Promise<Incident> {
    const issues: FieldError[] = [];
    this.#text(input.title, MAX_TITLE, '/title', issues);
    this.#status(input.status, '/status', issues);
    const known = new Set(this.deps.components.map((c) => c.id));
    if (
      !Array.isArray(input.component_ids) ||
      input.component_ids.length > 50 ||
      !input.component_ids.every((id) => typeof id === 'string' && known.has(id))
    ) {
      issues.push({
        pointer: '/component_ids',
        code: 'invalid_value',
        detail: 'must list configured components',
      });
    }
    if (issues.length > 0) throw validationFailed(issues, STATUS_ADMIN_DETAILS.invalid);
    const id = newId('inc');
    await this.deps.repository.createIncident({
      id,
      title: input.title,
      status: input.status,
      componentIds: [...new Set(input.component_ids)],
      startedAt: new Date(this.#clock()),
    });
    return this.#get(id);
  }

  /** Adds an update (at most 500 characters), and sets the incident's status when given. */
  async addIncidentUpdate(id: string, text: string, status?: IncidentStatus): Promise<Incident> {
    const issues: FieldError[] = [];
    this.#text(text, MAX_UPDATE_TEXT, '/text', issues);
    if (status !== undefined) this.#status(status, '/status', issues);
    if (issues.length > 0) throw validationFailed(issues, STATUS_ADMIN_DETAILS.invalid);
    const added = await this.deps.repository.addUpdate(id, {
      at: new Date(this.#clock()),
      text,
      status: status ?? null,
    });
    if (!added) throw notFound(STATUS_ADMIN_DETAILS.notFound);
    return this.#get(id);
  }

  /** Resolves an incident (it leaves the feed 7 days later). */
  async resolveIncident(id: string): Promise<Incident> {
    if (!(await this.deps.repository.resolve(id, new Date(this.#clock())))) {
      throw notFound(STATUS_ADMIN_DETAILS.notFound);
    }
    return this.#get(id);
  }

  /** Lists or moves a deprecation (`sunset` a `YYYY-MM-DD` date). */
  async setDeprecation(input: { what: string; sunset: string }): Promise<DeprecationRecord> {
    const issues: FieldError[] = [];
    this.#text(input.what, 200, '/what', issues);
    if (
      typeof input.sunset !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.sunset) ||
      Number.isNaN(Date.parse(input.sunset))
    ) {
      issues.push({
        pointer: '/sunset',
        code: 'invalid_format',
        detail: 'must be a YYYY-MM-DD date',
      });
    }
    if (issues.length > 0) throw validationFailed(issues, STATUS_ADMIN_DETAILS.invalid);
    await this.deps.repository.setDeprecation({ what: input.what, sunset: input.sunset });
    return { what: input.what, sunset: input.sunset };
  }

  async #get(id: string): Promise<Incident> {
    const incident = await this.deps.repository.getIncident(id);
    if (incident === null) throw notFound(STATUS_ADMIN_DETAILS.notFound);
    return present(incident);
  }

  #text(value: unknown, max: number, pointer: string, issues: FieldError[]): void {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
      issues.push({ pointer, code: 'invalid_value', detail: `must be 1 to ${max} characters` });
    } else if (isSecretLike(value)) {
      issues.push({
        pointer,
        code: 'not_allowed',
        detail: 'must not hold an e-mail or IP address or a credential',
      });
    }
  }

  #status(value: unknown, pointer: string, issues: FieldError[]): void {
    if (typeof value !== 'string' || !(INCIDENT_STATUSES as readonly string[]).includes(value)) {
      issues.push({
        pointer,
        code: 'invalid_value',
        detail: `must be one of ${INCIDENT_STATUSES.join(', ')}`,
      });
    }
  }
}
