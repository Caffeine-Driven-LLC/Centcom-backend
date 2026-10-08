/**
 * Health endpoints (B037, CT-STATUS):
 *
 * - `GET /healthz`: liveness, `200 {"status":"ok"}` whenever the process answers. It never
 *   touches a dependency.
 * - `GET /readyz`: readiness, `200 {"status":"ok","checks":{…}}` only when Redis answers, the
 *   database answers and its migrations are at this build's version; otherwise, and always while
 *   draining, `503 {"status":"degraded","checks":{…}}`. Each check gives up after 1.5 s, so the
 *   answer comes within 2 s whatever is down.
 *
 * The last answer is kept (`ready`) and refreshed every 5 s, so the upgrade path can refuse
 * connections (4503) while a dependency is down without probing on every connection.
 *
 * Owns: the probe, the readiness state and the two routes. Must not: say a check's error, a host
 * or a URL in a response.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RedisBackend } from '@centcom/core';
import type { HealthReport } from '@centcom/db';

/** How long one check may take. */
export const READINESS_TIMEOUT_MS = 1_500;
/** How often readiness is refreshed in the background. */
export const READINESS_INTERVAL_MS = 5_000;

/** Checks by name. */
export type ReadinessChecks = Record<string, { ok: boolean }>;

/** Answers the checks. */
export interface ReadinessProbe {
  check(): Promise<ReadinessChecks>;
}

const within = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('check failed'));
      },
    );
  });

/** The relay's dependencies: Redis, the database, and its migrations (B007 `healthCheck`). */
export function dependencyProbe(deps: {
  redis: Pick<RedisBackend, 'ping'>;
  db: () => Promise<HealthReport>;
  timeoutMs?: number;
}): ReadinessProbe {
  const ms = deps.timeoutMs ?? READINESS_TIMEOUT_MS;
  return {
    async check() {
      const [redis, db] = await Promise.all([
        within(deps.redis.ping(), ms).then(
          () => true,
          () => false,
        ),
        within(deps.db(), ms).then(
          (report) => report,
          () => null,
        ),
      ]);
      return {
        redis: { ok: redis },
        db: { ok: db?.ok === true },
        migrations: { ok: db?.migrationsAtExpected === true },
      };
    },
  };
}

/** The readiness answer. */
export interface ReadinessReport {
  ok: boolean;
  checks: ReadinessChecks;
}

/** Readiness state: the last probe's answer, and whether the relay is draining. */
export class Readiness {
  readonly #probe: ReadinessProbe;
  readonly #intervalMs: number;
  #ready = false;
  #draining = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(probe: ReadinessProbe, options: { intervalMs?: number } = {}) {
    this.#probe = probe;
    this.#intervalMs = options.intervalMs ?? READINESS_INTERVAL_MS;
  }

  /** True when the last probe passed and the relay is not draining. */
  get ready(): boolean {
    return this.#ready && !this.#draining;
  }

  get draining(): boolean {
    return this.#draining;
  }

  /** Probes now (never rejects). */
  async refresh(): Promise<ReadinessReport> {
    if (this.#draining) return { ok: false, checks: { draining: { ok: false } } };
    let checks: ReadinessChecks;
    try {
      checks = await this.#probe.check();
    } catch {
      checks = { probe: { ok: false } };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    this.#ready = ok;
    if (this.#draining) return { ok: false, checks: { ...checks, draining: { ok: false } } };
    return { ok, checks };
  }

  /** Refreshes every interval until `stop`. */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** From now on not ready (shutdown). */
  drain(): void {
    this.#draining = true;
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

/** Answers `/healthz` and `/readyz`; false for any other request (the caller answers it). */
export function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  readiness: Readiness,
): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'GET' || (path !== '/healthz' && path !== '/readyz')) return false;
  if (path === '/healthz') {
    json(res, 200, { status: 'ok' });
    return true;
  }
  void readiness.refresh().then((report) =>
    json(res, report.ok ? 200 : 503, {
      status: report.ok ? 'ok' : 'degraded',
      checks: report.checks,
    }),
  );
  return true;
}
