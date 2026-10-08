/**
 * Browser login sessions (B018): who is signed in to the browser that calls
 * `GET /v1/auth/authorize`. A session is a 256-bit random id in the `centcom_sid` cookie
 * (`HttpOnly; Secure; SameSite=Lax`, path `/`) and a Redis (B009) record under the id's SHA-256,
 * valid 30 days and slid forward on every use. The login lanes call `establishLoginSession` once
 * they have authenticated someone; that always mints a new id and drops the browser's old one,
 * so an id planted before login is worthless after it (session fixation).
 *
 * Owns: the session records and the `centcom_sid` cookie. Must not: store an id in clear, keep an
 * old id alive across a login, or fall back to process memory when Redis is down (503 instead).
 */
import { createHash, randomBytes } from 'node:crypto';
import { isId } from '@centcom/contracts';
import type { KeyValue } from '@centcom/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LoginCompleter } from '../../../routes/login-social.js';
import { redisStep } from '../pkce/code-store.js';
import {
  clearLoginSessionCookieHeader,
  LOGIN_SESSION_COOKIE,
  loginSessionCookieHeader,
  readCookie,
} from './cookies.js';

/** How long a session lasts without use (sliding). */
export const LOGIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session id: 32 random bytes, base64url. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Dependencies of the login sessions. */
export interface LoginSessionDeps {
  kv: KeyValue;
  /** Milliseconds since the epoch; default Date.now. */
  now?: () => number;
}

/** The browser login session API (B018 interface for the login lanes). */
export interface LoginSessions {
  /** Starts a session for `userId` on a new id, ends the browser's previous one, sets the cookie. */
  establishLoginSession(reply: FastifyReply, userId: string): Promise<void>;
  /**
   * The signed-in user of the request's session, or null. A live session is slid forward; with
   * `reply`, the cookie's lifetime is renewed too.
   */
  getLoginSession(
    request: FastifyRequest,
    reply?: FastifyReply,
  ): Promise<{ userId: string } | null>;
  /** Ends the request's session (logout) and clears the cookie. */
  endLoginSession(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

const sessionKey = (id: string): string =>
  `auth:sid:${createHash('sha256').update(id).digest('hex')}`;

/** The session id in the request's cookie, when it is well formed. */
function sessionIdOf(request: FastifyRequest): string | undefined {
  const id = readCookie(request.headers.cookie, LOGIN_SESSION_COOKIE);
  return id !== undefined && SESSION_ID_PATTERN.test(id) ? id : undefined;
}

/** A stored session, or undefined when the value is not one. */
function readSession(raw: string): { userId: string; expiresAt: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const { usr, exp } = (value ?? {}) as Record<string, unknown>;
  return isId('usr', usr) && typeof exp === 'number' ? { userId: usr, expiresAt: exp } : undefined;
}

/** Login sessions on a KeyValue store. */
export function createLoginSessions(deps: LoginSessionDeps): LoginSessions {
  const { kv } = deps;
  const now = deps.now ?? Date.now;
  const maxAgeS = LOGIN_SESSION_TTL_MS / 1000;

  const save = (id: string, userId: string): Promise<void> =>
    redisStep(() =>
      kv.set(sessionKey(id), JSON.stringify({ usr: userId, exp: now() + LOGIN_SESSION_TTL_MS }), {
        ttlMs: LOGIN_SESSION_TTL_MS,
      }),
    );

  return {
    async establishLoginSession(reply, userId) {
      if (!isId('usr', userId)) throw new TypeError('establishLoginSession: not a usr_ id');
      const previous = sessionIdOf(reply.request);
      if (previous !== undefined) await redisStep(() => kv.del(sessionKey(previous)));
      const id = randomBytes(32).toString('base64url');
      await save(id, userId);
      void reply.header('set-cookie', loginSessionCookieHeader(id, maxAgeS));
    },

    async getLoginSession(request, reply) {
      const id = sessionIdOf(request);
      if (id === undefined) return null;
      const raw = await redisStep(() => kv.get(sessionKey(id)));
      const session = raw === null ? undefined : readSession(raw);
      if (session === undefined || session.expiresAt <= now()) return null;
      await save(id, session.userId);
      if (reply !== undefined)
        void reply.header('set-cookie', loginSessionCookieHeader(id, maxAgeS));
      return { userId: session.userId };
    },

    async endLoginSession(request, reply) {
      const id = sessionIdOf(request);
      if (id !== undefined) await redisStep(() => kv.del(sessionKey(id)));
      void reply.header('set-cookie', clearLoginSessionCookieHeader());
    },
  };
}

/**
 * The `LoginCompleter` the e-mail and social login routes (B014, B015) finish with: a new login
 * session for the user, then 303 to the `return_to` those routes already resolved against their
 * allow-list.
 */
export function webLoginCompleter(
  sessions: Pick<LoginSessions, 'establishLoginSession'>,
): LoginCompleter {
  return {
    async complete(reply, userId, returnTo) {
      await sessions.establishLoginSession(reply, userId);
      await reply.header('cache-control', 'no-store').redirect(returnTo, 303);
    },
  };
}
