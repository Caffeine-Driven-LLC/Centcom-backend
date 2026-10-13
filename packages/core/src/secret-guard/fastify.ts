/**
 * Surface 2a, REST (B101): `secretGuardHook()` is a Fastify `preValidation` hook that rejects a
 * request with `400 invalid_request` (the same generic body for every pattern: no oracle for
 * probing) when its body, query, path parameters or headers hold a provider credential. The
 * `Authorization` header is not scanned: it carries the service's own access token. The handler
 * does not run, and nothing about the match is logged, counted in a label or returned.
 *
 * Fail closed: a scanner failure rejects; a scan over its 20 ms budget answers `413
 * payload_too_large` instead of skipping the check.
 *
 * Owns: choosing what to scan and the rejection. Must not: log, label or echo matched text, or
 * pass a request it could not scan. Mounted by the API lane: `app.addHook('preValidation', hook)`.
 */
import { isId, newId } from '@centcom/contracts';
import { AppError } from '../errors/app-error.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from '../errors/problem.js';
import type { Logger } from '../log/logger.js';
import type { Metrics } from '../log/metrics.js';
import { performance } from 'node:perf_hooks';
import type { AllowList } from './allow.js';
import { guardMetrics } from './metrics.js';
import { SCAN_BUDGET_MS, scanJson, scanText, ScanLimitError, type Hit } from './scan.js';

/** The default largest body scanned (SECRET_GUARD_MAX_BODY_BYTES). */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** The part of a Fastify request the hook reads. */
export interface GuardRequest {
  readonly id?: string;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly params?: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly routeOptions?: { readonly url?: string | undefined };
}

/** The part of a Fastify reply the hook uses. */
export interface GuardReply {
  code(statusCode: number): GuardReply;
  header(name: string, value: string): GuardReply;
  send(payload?: unknown): GuardReply;
}

/** A Fastify `preValidation` hook. */
export type SecretGuardHook = (
  request: GuardRequest,
  reply: GuardReply,
) => Promise<GuardReply | undefined>;

/** Options for `secretGuardHook`. */
export interface SecretGuardHookOptions {
  allow?: AllowList;
  metrics?: Metrics;
  /** Gets `{surface, pattern, route, size}` on a rejection. */
  logger?: Logger;
  /** False (SECRET_GUARD_ENABLED=false, tests only): the hook passes everything. */
  enabled?: boolean;
  /** Default DEFAULT_MAX_BODY_BYTES. */
  maxBodyBytes?: number;
  /** Headers not scanned; default `authorization` (the service's own token). */
  skipHeaders?: readonly string[];
}

/** The response text of every rejection. */
export const REJECTION_DETAIL = 'request rejected';

/** Builds the hook. */
export function secretGuardHook(o: SecretGuardHookOptions = {}): SecretGuardHook {
  const metrics = guardMetrics(o.metrics);
  const maxBody = o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const skip = new Set((o.skipHeaders ?? ['authorization']).map((h) => h.toLowerCase()));

  return async (request, reply) => {
    if (o.enabled === false) return undefined;
    const started = performance.now();
    const route = request.routeOptions?.url;
    const options = {
      ...(o.allow === undefined ? {} : { allow: o.allow }),
      ...(route === undefined ? {} : { location: { route } }),
    };
    const left = (): number => Math.max(1, SCAN_BUDGET_MS - (performance.now() - started));
    let size = 0;
    let found: Hit | undefined;
    let tooLarge = false;
    try {
      const body = request.body;
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        size = body.length;
        if (size > maxBody) tooLarge = true;
        else found = scanText(typeof body === 'string' ? body : body.toString('utf8'), options)[0];
      } else if (body !== undefined && body !== null) {
        found = scanJson(body, { ...options, budgetMs: left() })[0];
      }
      if (found === undefined && !tooLarge) {
        found = scanJson(request.query, { ...options, budgetMs: left() })[0];
      }
      if (found === undefined && !tooLarge) {
        found = scanJson(request.params, { ...options, budgetMs: left() })[0];
      }
      if (found === undefined && !tooLarge) {
        for (const [name, value] of Object.entries(request.headers)) {
          if (skip.has(name.toLowerCase()) || value === undefined) continue;
          found = scanJson(value, { ...options, budgetMs: left() })[0];
          if (found !== undefined) break;
        }
      }
    } catch (err) {
      tooLarge = err instanceof ScanLimitError && err.reason === 'budget';
      found = tooLarge ? undefined : { pattern: 'unscannable', offset: 0, length: 0 };
    }
    metrics.scanned('rest', (performance.now() - started) / 1000);
    if (found === undefined && !tooLarge) return undefined;

    const pattern = found?.pattern ?? 'too_large';
    metrics.hit('rest', pattern);
    o.logger?.warn(
      { surface: 'rest', pattern, route: route ?? 'unmatched', size },
      'secret_guard_hit',
    );
    const requestId = isId('req', request.id) ? request.id : newId('req');
    const error = tooLarge
      ? new AppError('payload_too_large', { detail: REJECTION_DETAIL })
      : new AppError('invalid_request', { detail: REJECTION_DETAIL });
    const problem = toProblem(error, {
      requestId,
      ...(route === undefined ? {} : { instance: route }),
    });
    return reply
      .code(problem.status)
      .header('content-type', PROBLEM_CONTENT_TYPE)
      .header('x-request-id', requestId)
      .send(JSON.stringify(problem));
  };
}
