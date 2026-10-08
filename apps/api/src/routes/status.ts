/**
 * Health and status (B086, CT-STATUS), all public and unauthenticated:
 *
 * - `GET /healthz`: `200 {"status":"ok"}` whenever the process answers; it touches nothing.
 * - `GET /readyz`: `200 {"status":"ok","checks":{...}}` when the database, Redis and migrations
 *   are ready, else `503 {"status":"degraded","checks":{...}}`; each check is `{ok}` only.
 * - `GET /v1/status`: the public feed (`StatusFeed`), `public, max-age=15`, with an ETag
 *   (`If-None-Match` gives 304). Always 200: it is informational, and clients must never gate
 *   local or LAN use on it.
 *
 * `/healthz` and `/readyz` are on B023's default exempt routes; `/v1/status` counts against the
 * anonymous limit. Owns: the HTTP side. Must not: show an error, a host or a version of a dependency.
 */
import type { FastifyPluginAsync } from 'fastify';
import { ifNoneMatchHits } from '../modules/entitlements/etag.js';
import type { Readiness } from '../modules/status/readiness.js';
import type { StatusFeed } from '../modules/status/service.js';

/** Options for `statusRoutes`. */
export interface StatusRouteOptions {
  feed: Pick<StatusFeed, 'current'>;
  readiness: Pick<Readiness<unknown>, 'check'>;
}

/** `max-age` of the feed (CT-STATUS: cached 15 s at the edge). */
export const STATUS_MAX_AGE_S = 15;

const PUBLIC = { config: { auth: false as const } };
const HEALTHY = JSON.stringify({ status: 'ok' });

export const statusRoutes: FastifyPluginAsync<StatusRouteOptions> = async (
  app,
  { feed, readiness },
) => {
  app.get('/healthz', PUBLIC, (_request, reply) => {
    void reply
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(HEALTHY);
  });

  app.get('/readyz', PUBLIC, async (_request, reply) => {
    const report = await readiness.check();
    void reply.header('cache-control', 'no-store').code(report.ok ? 200 : 503);
    return { status: report.ok ? 'ok' : 'degraded', checks: report.checks };
  });

  app.get('/v1/status', PUBLIC, async (request, reply) => {
    const snapshot = await feed.current();
    void reply
      .header('etag', snapshot.etag)
      .header('cache-control', `public, max-age=${STATUS_MAX_AGE_S}`);
    if (ifNoneMatchHits(request.headers['if-none-match'], snapshot.etag))
      return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(snapshot.body);
  });
};
