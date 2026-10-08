/**
 * Staff authentication (B087): who may use the admin API, checked on every call.
 *
 * `requireStaff(minRole)` is the preHandler of every admin route (and of B089's): in order,
 *
 * 1. no impersonation: a header naming a workspace or another user (`X-Centcom-Workspace`,
 *    `X-Act-As`, ...) or a query parameter the route does not take is a 400 `invalid_request`;
 * 2. a bearer access token (401 `unauthorized`, `token_expired`, `token_invalid`, `token_revoked`,
 *    `device_revoked`; tokens with `admin` fail closed when revocation cannot be checked);
 * 3. a user's token (not an API key) with scope `admin`, and an enabled `staff_users` row, read at
 *    most 5 s ago: 403 `forbidden` otherwise;
 * 4. at most 60 calls a minute per staff user: 429 `rate_limited` with `Retry-After`;
 * 5. `X-Admin-Reason` (10-500 characters) and, optionally, `X-Admin-Ticket` (1-64 characters of
 *    `[A-Za-z0-9._#:/-]`): 422 `validation_failed` otherwise;
 * 6. a role at least `minRole`: 403 `forbidden` otherwise.
 *
 * Every refusal is a thrown AppError; the admin plugin records it as a `denied` call. A failure to
 * look anything up refuses (503): there is no un-checked access.
 *
 * Owns: the checks and the staff cache. Must not: let a staff row live in the cache over 5 s, or
 * accept a reason it did not check.
 */
import { hasControlChars } from '@centcom/contracts';
import {
  AppError,
  forbidden,
  isAppError,
  tooManyRequests,
  unavailable,
  validationFailed,
  type RateLimitStore,
} from '@centcom/core';
import type { StaffRole } from '@centcom/db';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AdminCall } from './call.js';
import { ADMIN_RATE_LIMIT, ADMIN_RATE_WINDOW_S, STAFF_CACHE_TTL_MS } from './config.js';
import type { AdminTokens } from './ports.js';
import type { AdminReader } from './repository.js';
import { STAFF_ROLES } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The admin call being made, on the admin listener; null elsewhere. */
    adminCall: AdminCall | null;
  }
  interface FastifyInstance {
    /** What `requireStaff` checks with, on the admin listener. */
    adminAccess: AdminAccess;
  }
  interface FastifyContextConfig {
    /** The query parameters an admin route takes; any other is refused. */
    adminQuery?: readonly string[];
  }
}

/** What the checks need. */
export interface AdminAccess {
  tokens: Pick<AdminTokens, 'authenticate'>;
  directory: StaffDirectory;
  rateLimit: RateLimitStore;
}

/** The user-facing details of this module's refusals (GUIDELINES §3.4: one message table). */
export const STAFF_DETAILS = Object.freeze({
  noToken: 'A bearer token is required.',
  notStaff: 'This API is for Centcom staff.',
  role: 'Your staff role does not allow this.',
  rateLimited: 'Too many admin calls; slow down.',
  reason: 'Every admin call needs an X-Admin-Reason header of 10 to 500 characters.',
  impersonation: 'The admin API acts as staff only: it takes no workspace or user to act as.',
  unknownQuery: 'This route does not take that query parameter.',
  unavailable: 'Staff access cannot be checked right now.',
} as const);

/** Whether `role` is `min` or above. */
export function roleAtLeast(role: StaffRole, min: StaffRole): boolean {
  return STAFF_ROLES.indexOf(role) >= STAFF_ROLES.indexOf(min);
}

/** Options of the staff directory. */
export interface StaffDirectoryDeps {
  reader: Pick<AdminReader, 'staff'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** How long an answer is reused; default (and at most) 5 s. */
  ttlMs?: number;
}

/** Entries kept at most; older ones go first. */
const CACHE_MAX = 1000;

/** Staff roles by user, each read at most `ttlMs` ago. */
export class StaffDirectory {
  readonly #cache = new Map<string, { role: StaffRole | null; until: number }>();
  readonly #clock: () => number;
  readonly #ttlMs: number;

  constructor(private readonly deps: StaffDirectoryDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#ttlMs = Math.min(deps.ttlMs ?? STAFF_CACHE_TTL_MS, STAFF_CACHE_TTL_MS);
  }

  /** The user's role; null when they are not staff or their row is disabled. Rejects when it cannot tell. */
  async role(userId: string): Promise<StaffRole | null> {
    const now = this.#clock();
    const hit = this.#cache.get(userId);
    if (hit !== undefined && hit.until > now) return hit.role;
    const row = await this.deps.reader.staff(userId);
    const role = row === null || row.disabled_at !== null ? null : row.role;
    this.#cache.delete(userId);
    if (this.#cache.size >= CACHE_MAX) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(userId, { role, until: now + this.#ttlMs });
    return role;
  }

  /** Drops the cached role of `userId` (after this instance changed it). */
  forget(userId: string): void {
    this.#cache.delete(userId);
  }
}

/** RFC 6750 `b64token` after a case-insensitive `Bearer` scheme. */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;
/** Header names that would pick a workspace or a user to act as. */
const IMPERSONATION_HEADER =
  /workspace|impersonat|act-as|acting-as|run-as|on-behalf|as-user|sudo|^x-user|forwarded-user|remote-user|auth-user/i;
const TICKET = /^[A-Za-z0-9._#:/-]{1,64}$/;

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

/** A valid X-Admin-Reason, or null. */
export function validReason(header: string | string[] | undefined): string | null {
  const reason = single(header)?.trim();
  if (reason === undefined || hasControlChars(reason)) return null;
  const length = Array.from(reason).length;
  return length >= 10 && length <= 500 ? reason : null;
}

/** A valid X-Admin-Ticket, null when absent, undefined when present but invalid. */
export function validTicket(header: string | string[] | undefined): string | null | undefined {
  if (header === undefined) return null;
  const ticket = single(header)?.trim();
  return ticket !== undefined && TICKET.test(ticket) ? ticket : undefined;
}

/** Refuses a request that names a workspace or user to act as, or a query the route does not take. */
function checkImpersonation(request: FastifyRequest): void {
  for (const name of Object.keys(request.headers)) {
    if (IMPERSONATION_HEADER.test(name)) {
      throw new AppError('invalid_request', { detail: STAFF_DETAILS.impersonation });
    }
  }
  const allowed = request.routeOptions.config.adminQuery ?? [];
  const query = (request.query ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(query)) {
    if (!allowed.includes(name)) {
      throw new AppError('invalid_request', { detail: STAFF_DETAILS.unknownQuery });
    }
  }
}

/** Runs `lookup`; a failure that is not already a problem refuses with 503. */
async function guarded<T>(lookup: () => Promise<T>): Promise<T> {
  try {
    return await lookup();
  } catch (err) {
    if (isAppError(err)) throw err;
    throw unavailable(undefined, STAFF_DETAILS.unavailable);
  }
}

/** The access checks of one call (see the module comment); fills in `call` as it learns. */
export async function checkStaff(
  request: FastifyRequest,
  reply: FastifyReply,
  access: AdminAccess,
  call: AdminCall,
  minRole: StaffRole,
): Promise<void> {
  call.checked = true;
  call.reason = validReason(request.headers['x-admin-reason']);
  const ticket = validTicket(request.headers['x-admin-ticket']);
  call.ticket = ticket ?? null;
  checkImpersonation(request);

  const credential = BEARER.exec(single(request.headers.authorization) ?? '')?.[1];
  if (credential === undefined) {
    void reply.header('www-authenticate', 'Bearer');
    throw new AppError('unauthorized', { detail: STAFF_DETAILS.noToken });
  }
  let principal;
  try {
    principal = await access.tokens.authenticate(credential);
  } catch (err) {
    if (isAppError(err) && err.status === 401) {
      void reply.header('www-authenticate', 'Bearer error="invalid_token"');
    }
    throw isAppError(err) ? err : unavailable(undefined, STAFF_DETAILS.unavailable);
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw forbidden(STAFF_DETAILS.notStaff);
  }
  const userId = principal.userId;
  call.actor = { type: 'user', id: userId };
  if (!principal.scopes.includes('admin')) throw forbidden(STAFF_DETAILS.notStaff);
  const role = await guarded(() => access.directory.role(userId));
  if (role === null) throw forbidden(STAFF_DETAILS.notStaff);
  call.actor = { type: 'staff', id: userId };
  call.staff = { userId, role };

  const limited = await guarded(() =>
    access.rateLimit.consume(`admin:staff:${userId}`, ADMIN_RATE_LIMIT, ADMIN_RATE_WINDOW_S),
  );
  if (!limited.allowed) throw tooManyRequests(limited.resetS, STAFF_DETAILS.rateLimited);

  if (call.reason === null || ticket === undefined) {
    throw validationFailed(
      [
        ...(call.reason === null
          ? [
              {
                pointer: '/headers/x-admin-reason',
                code: 'invalid_value',
                detail: '10 to 500 characters',
              },
            ]
          : []),
        ...(ticket === undefined
          ? [
              {
                pointer: '/headers/x-admin-ticket',
                code: 'invalid_format',
                detail: '1 to 64 of [A-Za-z0-9._#:/-]',
              },
            ]
          : []),
      ],
      STAFF_DETAILS.reason,
    );
  }
  if (!roleAtLeast(role, minRole)) throw forbidden(STAFF_DETAILS.role);
  call.phase = 'work';
}

/**
 * The preHandler of an admin route: the caller must be staff with at least `minRole` (see the
 * module comment). For routes on the admin listener only (it reads `adminAccess` and the call the
 * admin plugin starts); B089 mounts its search routes with it.
 */
export function requireStaff(minRole: StaffRole): preHandlerAsyncHookHandler {
  return async function staffOnly(request, reply) {
    const call = request.adminCall;
    if (call === null) throw new TypeError('requireStaff: not on the admin listener');
    await checkStaff(request, reply, this.adminAccess, call, minRole);
  };
}
