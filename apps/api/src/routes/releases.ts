/**
 * Release manifests (B084, CT-API-RELEASES), public and unauthenticated:
 *
 * - `GET /v1/releases/{channel}/latest?platform=&arch=`: the newest unyanked release of `stable`,
 *   `beta` or `nightly` with an artifact for that platform and arch: its manifest with just those
 *   artifacts, plus `min_client_version`. `public, max-age=60`.
 * - `GET /v1/releases/{channel}/manifest.json`: the channel's newest release, its manifest exactly
 *   as published (all platforms). `public, max-age=300`.
 *
 * `platform` is `linux`, `darwin` or `win32` (the manifest's names) or `macos` / `windows`
 * (OpenAPI's); `arch` is `x64` or `arm64`. A missing or unknown one is 400 at `/platform` or
 * `/arch`, and so is a query string over 1 KiB; an unknown channel, or a channel or platform
 * without a release, is 404. Answers carry an
 * ETag; `If-None-Match` with it is 304. They come from the process's cache (`cache.ts`), and
 * count against the anonymous rate limit (B023: 30 a minute per address, `RateLimit-*` headers).
 *
 * Owns: the HTTP side. Must not: proxy or fetch an artifact, or accept a publish.
 */
import { AppError, notFound, type FieldError } from '@centcom/core';
import type { ReleaseChannel } from '@centcom/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ifNoneMatchHits } from '../modules/entitlements/etag.js';
import type { ReleaseCache, Served } from '../modules/releases/cache.js';
import { CHANNELS, type Arch, type Platform } from '../modules/releases/manifest.js';

/** Options for `releaseRoutes`. */
export interface ReleaseRouteOptions {
  releases: Pick<ReleaseCache, 'catalog'>;
}

/** The details of refusals (GUIDELINES §3.4). */
export const RELEASE_ROUTE_DETAILS = Object.freeze({
  unknownChannel: 'There is no such release channel.',
  noRelease: 'There is no release for this channel, platform and architecture.',
  badQuery: 'The platform or architecture is missing or unknown.',
  longQuery: 'The query string is too long.',
} as const);

/** The longest query string read; a longer one is 400 (these routes take two short parameters). */
export const MAX_QUERY_LENGTH = 1024;

/** `max-age` of the two answers. */
export const LATEST_MAX_AGE_S = 60;
export const MANIFEST_MAX_AGE_S = 300;

const PLATFORM_NAMES: Readonly<Record<string, Platform>> = Object.freeze({
  linux: 'linux',
  darwin: 'darwin',
  macos: 'darwin',
  win32: 'win32',
  windows: 'win32',
});
const ARCH_NAMES: Readonly<Record<string, Arch>> = Object.freeze({ x64: 'x64', arm64: 'arm64' });

function channelOf(request: FastifyRequest): ReleaseChannel {
  const channel = (request.params as Record<string, unknown>)['channel'];
  if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
    throw notFound(RELEASE_ROUTE_DETAILS.unknownChannel);
  }
  return channel as ReleaseChannel;
}

/** The value of `name` among `names`, or an issue. */
function pick<T>(
  query: Record<string, unknown>,
  name: string,
  names: Readonly<Record<string, T>>,
  issues: FieldError[],
): T | undefined {
  const value = query[name];
  if (value === undefined) {
    issues.push({ pointer: `/${name}`, code: 'required', detail: 'is required' });
    return undefined;
  }
  if (typeof value === 'string' && Object.hasOwn(names, value)) return names[value];
  issues.push({
    pointer: `/${name}`,
    code: 'invalid_value',
    detail: `must be one of ${Object.keys(names).join(', ')}`,
  });
  return undefined;
}

function send(request: FastifyRequest, reply: FastifyReply, served: Served, maxAge: number) {
  void reply.header('etag', served.etag).header('cache-control', `public, max-age=${maxAge}`);
  if (ifNoneMatchHits(request.headers['if-none-match'], served.etag)) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(served.body);
}

export const releaseRoutes: FastifyPluginAsync<ReleaseRouteOptions> = async (app, { releases }) => {
  const PUBLIC = { config: { auth: false as const } };

  app.get('/v1/releases/:channel/latest', PUBLIC, async (request, reply) => {
    const channel = channelOf(request);
    const at = request.url.indexOf('?');
    if (at !== -1 && request.url.length - at - 1 > MAX_QUERY_LENGTH) {
      throw new AppError('invalid_request', { detail: RELEASE_ROUTE_DETAILS.longQuery });
    }
    const query = (request.query ?? {}) as Record<string, unknown>;
    const issues: FieldError[] = [];
    const platform = pick(query, 'platform', PLATFORM_NAMES, issues);
    const arch = pick(query, 'arch', ARCH_NAMES, issues);
    if (issues.length > 0 || platform === undefined || arch === undefined) {
      throw new AppError('invalid_request', {
        detail: RELEASE_ROUTE_DETAILS.badQuery,
        errors: issues,
      });
    }
    const served = (await releases.catalog()).get(channel)?.latest.get(`${platform}/${arch}`);
    if (served === undefined) throw notFound(RELEASE_ROUTE_DETAILS.noRelease);
    return send(request, reply, served, LATEST_MAX_AGE_S);
  });

  app.get('/v1/releases/:channel/manifest.json', PUBLIC, async (request, reply) => {
    const channel = channelOf(request);
    const served = (await releases.catalog()).get(channel)?.manifest;
    if (served === undefined || served === null) throw notFound(RELEASE_ROUTE_DETAILS.noRelease);
    return send(request, reply, served, MANIFEST_MAX_AGE_S);
  });
};
