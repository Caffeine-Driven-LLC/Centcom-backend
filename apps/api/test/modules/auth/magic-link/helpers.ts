/**
 * Test helpers for e-mail sign-in (B014): an in-memory token store with the Postgres store's
 * semantics (hashes only, atomic single use, expiry by the caller's clock), a mailer that captures
 * links (and can fail), users in memory with statuses, and the routes on the API's plugin stack
 * with the rate limiter (B023) and a LoginCompleter stand-in for B018.
 */
import {
  createMemoryRedis,
  DEFAULT_EXEMPT_ROUTES,
  defaultBuckets,
  type RateLimitStore,
} from '@centcom/core';
import { createIdGenerator } from '@centcom/contracts';
import type { User } from '@centcom/db';
import { fastify, type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { returnToPolicy } from '../../../../src/modules/auth/return-to.js';
import {
  MagicLinkService,
  type MagicLinkServiceOptions,
} from '../../../../src/modules/auth/magic-link/service.js';
import type {
  LoginTokenStore,
  NewLoginToken,
} from '../../../../src/modules/auth/magic-link/store.js';
import type { MagicLinkMailer } from '../../../../src/modules/auth/magic-link/mailer.js';
import { errorHandlerPlugin } from '../../../../src/plugins/error-handler.js';
import { rateLimitPlugin } from '../../../../src/plugins/rate-limit.js';
import { requestContextPlugin } from '../../../../src/plugins/request-context.js';
import { emailLoginRoutes, NONCE_COOKIE } from '../../../../src/routes/login-email.js';
import type { LoginCompleter } from '../../../../src/routes/login-social.js';
import { captureLogger, recordingMetrics } from '../../../helpers.js';

export const newId = createIdGenerator();
export const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
export const ALLOWLIST = ['https://app.centcom.test/', 'https://app.centcom.test/settings'];
export const BASE_URL = 'https://api.centcom.test';

/** A clock tests move by hand. */
export class FakeClock {
  now = NOW;
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** The in-memory store, with every row it holds. */
export function memoryStore(): LoginTokenStore & {
  rows: (NewLoginToken & { usedAt: Date | null })[];
  down: boolean;
} {
  const store = {
    rows: [] as (NewLoginToken & { usedAt: Date | null })[],
    down: false,
    insert(token: NewLoginToken) {
      if (store.down) return Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432'));
      store.rows.push({ ...token, usedAt: null });
      return Promise.resolve();
    },
    consume(tokenHash: string, nonceHash: string, now: Date) {
      if (store.down) return Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432'));
      const row = store.rows.find(
        (r) =>
          r.tokenHash === tokenHash &&
          r.nonceHash === nonceHash &&
          r.usedAt === null &&
          r.expiresAt.getTime() > now.getTime(),
      );
      if (row === undefined) return Promise.resolve(null);
      row.usedAt = now;
      return Promise.resolve({ email: row.email, returnTo: row.returnTo });
    },
    invalidate(tokenHash: string, now: Date) {
      const row = store.rows.find((r) => r.tokenHash === tokenHash && r.usedAt === null);
      if (row !== undefined) row.usedAt = now;
      return Promise.resolve();
    },
  };
  return store;
}

/** A mailer that keeps every link it is given; `failWith` makes the next sends fail. */
export function capturingMailer(): MagicLinkMailer & {
  sent: { to: string; link: string; locale: string }[];
  attempts: number;
  failWith?: () => Error;
} {
  const mailer = {
    sent: [] as { to: string; link: string; locale: string }[],
    attempts: 0,
    failWith: undefined as (() => Error) | undefined,
    send(to: string, link: string, locale: string) {
      mailer.attempts += 1;
      if (mailer.failWith !== undefined) return Promise.reject(mailer.failWith());
      mailer.sent.push({ to, link, locale });
      return Promise.resolve();
    },
  };
  return mailer;
}

/** Users by address; signing in with an unknown one creates an active user. */
export function memoryUsers(): MagicLinkServiceOptions['users'] & {
  byEmail: Map<string, Pick<User, 'id' | 'status'>>;
  lookups: number;
} {
  const users = {
    byEmail: new Map<string, Pick<User, 'id' | 'status'>>(),
    lookups: 0,
    getOrCreateByEmail(email: string) {
      users.lookups += 1;
      let user = users.byEmail.get(email);
      if (user === undefined) {
        user = { id: newId('usr'), status: 'active' };
        users.byEmail.set(email, user);
      }
      return Promise.resolve({ user });
    },
  };
  return users;
}

/** The token in a captured link. */
export const tokenOf = (link: string): string => new URL(link).searchParams.get('t') ?? '';

/** The nonce a response set. */
export function nonceOf(response: LightMyRequestResponse): string {
  const header = String(response.headers['set-cookie'] ?? '');
  const match = new RegExp(`${NONCE_COOKIE}=([^;]+)`).exec(header);
  if (match?.[1] === undefined) throw new Error('no nonce cookie');
  return match[1];
}

/** Everything a test needs: the service and its fakes, and the routes on the plugin stack. */
export async function magicLinkApp(
  overrides: Partial<MagicLinkServiceOptions> & {
    rateLimitStore?: RateLimitStore;
    /** The completer answers itself (as B018's will), instead of leaving the 303 to the route. */
    completerSends?: boolean;
    secureCookies?: boolean;
  } = {},
): Promise<{
  app: FastifyInstance;
  service: MagicLinkService;
  store: ReturnType<typeof memoryStore>;
  mailer: ReturnType<typeof capturingMailer>;
  users: ReturnType<typeof memoryUsers>;
  clock: FakeClock;
  captured: ReturnType<typeof captureLogger>;
  recorded: ReturnType<typeof recordingMetrics>;
  completed: { userId: string; returnTo: string }[];
}> {
  const clock = new FakeClock();
  const backend = createMemoryRedis(clock.read);
  const store = memoryStore();
  const mailer = capturingMailer();
  const users = memoryUsers();
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const service = new MagicLinkService({
    store,
    mailer,
    users,
    rateLimit: backend.rateLimit,
    returnTo: returnToPolicy(ALLOWLIST),
    baseUrl: BASE_URL,
    clock: clock.read,
    sleep: () => Promise.resolve(),
    logger: captured.logger,
    metrics: recorded.metrics,
    ...overrides,
  });
  const completed: { userId: string; returnTo: string }[] = [];
  const completer: LoginCompleter = {
    async complete(reply, userId, returnTo) {
      completed.push({ userId, returnTo });
      void reply.header('x-test-signed-in', userId);
      if (overrides.completerSends === true) await reply.redirect(`${returnTo}#signed-in`, 303);
    },
  };
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(rateLimitPlugin, {
    store: overrides.rateLimitStore ?? createMemoryRedis(clock.read).rateLimit,
    config: { buckets: defaultBuckets, trustedHops: 0, exempt: DEFAULT_EXEMPT_ROUTES },
    clock: clock.read,
  });
  await app.register(emailLoginRoutes, {
    magicLink: service,
    completer,
    ttlS: 900,
    logger: captured.logger,
    ...(overrides.secureCookies === undefined ? {} : { secureCookies: overrides.secureCookies }),
  });
  await app.ready();
  return { app, service, store, mailer, users, clock, captured, recorded, completed };
}

/** Asks for a link for `email` from `ip`, as a form post; returns the response. */
export const requestLink = (
  app: FastifyInstance,
  email: string,
  opts: { ip?: string; cookie?: string; returnTo?: string } = {},
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: '/login/email',
    remoteAddress: opts.ip ?? '203.0.113.7',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    },
    payload: new URLSearchParams({
      email,
      ...(opts.returnTo === undefined ? {} : { return_to: opts.returnTo }),
    }).toString(),
  });

/** Uses a link: POSTs the token with the browser's nonce cookie and the matching CSRF token. */
export const useLink = (
  app: FastifyInstance,
  token: string,
  nonce: string | undefined,
  csrf: string,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: '/login/email/verify',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(nonce === undefined ? {} : { cookie: `${NONCE_COOKIE}=${nonce}` }),
    },
    payload: new URLSearchParams({ t: token, csrf }).toString(),
  });
