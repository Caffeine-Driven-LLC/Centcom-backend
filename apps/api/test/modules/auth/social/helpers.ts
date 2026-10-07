/**
 * Test helpers for social login (B015): a fake GitHub and Google behind an injected `fetch`
 * (canned JSON, a test RSA key and JWKS for ID tokens, calls recorded, optional hangs), a test
 * configuration, in-memory users and identities with B013's and the table's semantics, and the
 * routes on a Fastify app with a recording LoginCompleter.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createIdGenerator } from '@centcom/contracts';
import { Secret, type Logger } from '@centcom/core';
import type { IdentityProvider, User } from '@centcom/db';
import { fastify, type FastifyInstance, type FastifyReply } from 'fastify';
import { SignJWT, type JWTPayload } from 'jose';
import type { SignInResult } from '../../../../src/modules/users/service.js';
import { returnToPolicy } from '../../../../src/modules/auth/return-to.js';
import {
  GITHUB,
  GOOGLE,
  SocialLoginService,
  type Fetch,
  type IdentityRepo,
  type SocialConfig,
  type SocialLoginDeps,
  type UserSignIn,
} from '../../../../src/modules/auth/social/index.js';
import { errorHandlerPlugin } from '../../../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../../../src/plugins/request-context.js';
import { socialLoginRoutes, type LoginCompleter } from '../../../../src/routes/login-social.js';
import { captureLogger } from '../../../helpers.js';

export const newId = createIdGenerator();

/** The tests' epoch. */
export const T0 = Date.parse('2026-10-07T12:00:00.000Z');
export const APP = 'https://app.centcom.test/';
export const SETTINGS = 'https://app.centcom.test/settings';
export const GITHUB_CLIENT = 'gh-client-id';
export const GOOGLE_CLIENT = '1234.apps.googleusercontent.test';

/** Secret-shaped test values are made at run time, never written out. */
export const runtimeSecret = (label: string): string =>
  `${label}-${randomBytes(18).toString('base64url')}`;

/** Both providers on; the allow-list holds the app root (the default) and its settings page. */
export function testConfig(
  overrides: Partial<SocialConfig> = {},
): SocialConfig & { secrets: string[] } {
  const githubSecret = runtimeSecret('gh');
  const googleSecret = runtimeSecret('gg');
  const stateSecret = runtimeSecret('state-key-0123456789');
  return {
    providers: {
      github: { clientId: GITHUB_CLIENT, clientSecret: new Secret(githubSecret) },
      google: { clientId: GOOGLE_CLIENT, clientSecret: new Secret(googleSecret) },
    },
    redirectBaseUrl: 'https://api.centcom.test',
    stateSecret: new Secret(stateSecret),
    returnTo: returnToPolicy([APP, SETTINGS]),
    secrets: [githubSecret, googleSecret, stateSecret],
    ...overrides,
  };
}

/** Google's test signing keys by kid, each made once per file. */
const googleKeys = new Map<string, { privateKey: KeyObject; jwk: Record<string, unknown> }>();
export function googleSigningKey(kid = 'google-test-1'): {
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
} {
  let key = googleKeys.get(kid);
  if (key === undefined) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    key = {
      privateKey,
      jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
    };
    googleKeys.set(kid, key);
  }
  return key;
}

/** A Google ID token: valid for our client and `nonce` unless the overrides say otherwise. */
export async function googleIdToken(
  claims: JWTPayload & { nonce?: string },
  opts: {
    nowMs?: number;
    audience?: string;
    issuer?: string;
    ttlS?: number;
    key?: KeyObject;
    kid?: string;
    alg?: string;
  } = {},
): Promise<string> {
  const iat = Math.floor((opts.nowMs ?? T0) / 1000);
  const { privateKey, jwk } = googleSigningKey(opts.kid);
  return new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: String(jwk['kid']) })
    .setIssuer(opts.issuer ?? 'https://accounts.google.com')
    .setAudience(opts.audience ?? GOOGLE_CLIENT)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttlS ?? 3600))
    .sign(opts.key ?? privateKey);
}

/** One recorded provider call. */
export interface ProviderCallRecord {
  url: string;
  method: string;
  body: string;
  authorization?: string;
}

/** What the fake providers answer; each piece can be changed between calls. */
export interface FakeProviders {
  fetch: Fetch;
  calls: ProviderCallRecord[];
  github: {
    token: unknown;
    tokenStatus: number;
    user: unknown;
    emails: unknown;
  };
  google: {
    /** Builds the token response; gets the nonce of the authorize URL begun last. */
    token: (nonce: string) => Promise<unknown>;
    tokenStatus: number;
    jwks: unknown;
  };
  /** Hosts whose calls never answer (until the call is aborted). */
  hang: Set<string>;
  /** The nonce the service sent in the last Google authorize URL (the test reads it from begin). */
  nonce: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake GitHub and Google, with a GitHub user (verified primary) and a Google account. */
export function fakeProviders(): FakeProviders {
  const githubToken = runtimeSecret('gh-access');
  const fake: FakeProviders = {
    calls: [],
    github: {
      token: { access_token: githubToken, token_type: 'bearer', scope: 'read:user,user:email' },
      tokenStatus: 200,
      user: { id: 4242, login: 'octo', name: 'Octo Cat' },
      emails: [
        { email: 'octo@example.test', primary: true, verified: true, visibility: 'private' },
        { email: 'octo-old@example.test', primary: false, verified: false, visibility: null },
      ],
    },
    google: {
      token: async (nonce) => ({
        access_token: runtimeSecret('gg-access'),
        id_token: await googleIdToken({
          sub: '108000000000000000001',
          email: 'gina@example.test',
          name: 'Gina',
          nonce,
        }),
      }),
      tokenStatus: 200,
      jwks: { keys: [googleSigningKey().jwk] },
    },
    hang: new Set(),
    nonce: '',
    fetch: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      fake.calls.push({
        url: `${url.origin}${url.pathname}`,
        method: init?.method ?? 'GET',
        body:
          init?.body === undefined || init.body === null
            ? ''
            : String(init.body as URLSearchParams),
        ...(authorization === null ? {} : { authorization }),
      });
      if (fake.hang.has(url.host)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')),
          );
        });
      }
      const target = `${url.origin}${url.pathname}`;
      if (target === GITHUB.token) return json(fake.github.token, fake.github.tokenStatus);
      if (target === `${GITHUB.api}/user`) return json(fake.github.user);
      if (target === `${GITHUB.api}/user/emails`) return json(fake.github.emails);
      if (target === GOOGLE.token)
        return json(await fake.google.token(fake.nonce), fake.google.tokenStatus);
      if (target === GOOGLE.jwks) return json(fake.google.jwks);
      return json({ message: 'Not Found' }, 404);
    },
  };
  return fake;
}

/** Users as B013 keeps them: one per lower-cased e-mail; `getOrCreateByEmail` creates or returns. */
export function memoryUsers(): UserSignIn & { users: Map<string, User> } {
  const users = new Map<string, User>();
  return {
    users,
    getOrCreateByEmail(email: string, hints: { name?: string } = {}): Promise<SignInResult> {
      const key = email.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(key)) {
        return Promise.reject(
          Object.assign(new Error('validation_failed'), { code: 'validation_failed' }),
        );
      }
      const existing = users.get(key);
      if (existing !== undefined) return Promise.resolve({ user: existing, created: false });
      const at = new Date(T0);
      const user: User = {
        id: newId('usr'),
        email: key,
        display_name: hints.name ?? key.slice(0, key.indexOf('@')),
        locale: 'en',
        avatar_slot: null,
        telemetry_opt_in: false,
        status: 'active',
        deletion_requested_at: null,
        created_at: at,
        updated_at: at,
      };
      users.set(key, user);
      return Promise.resolve({ user, created: true });
    },
  };
}

/** Identities as the table keeps them: one link per (provider, subject), first come. */
export function memoryIdentities(): IdentityRepo & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const key = (provider: IdentityProvider, subject: string): string => `${provider}|${subject}`;
  return {
    rows,
    findUserId: (provider, subject) => Promise.resolve(rows.get(key(provider, subject)) ?? null),
    link: (provider, subject, userId) => {
      if (rows.has(key(provider, subject))) return Promise.resolve(false);
      rows.set(key(provider, subject), userId);
      return Promise.resolve(true);
    },
  };
}

/** A service over the fakes. */
export function socialService(overrides: Partial<SocialLoginDeps> = {}): {
  service: SocialLoginService;
  providers: FakeProviders;
  users: ReturnType<typeof memoryUsers>;
  identities: ReturnType<typeof memoryIdentities>;
  config: ReturnType<typeof testConfig>;
  clock: { now: () => number; advance: (ms: number) => void };
} {
  let now = T0;
  const clock = { now: () => now, advance: (ms: number) => void (now += ms) };
  const providers = fakeProviders();
  const users = memoryUsers();
  const identities = memoryIdentities();
  const config = testConfig();
  const service = new SocialLoginService({
    config,
    users,
    identities,
    fetch: providers.fetch,
    now: clock.now,
    ...overrides,
  });
  return { service, providers, users, identities, config, clock };
}

/** Starts a login and returns what the browser would carry back (the state and its cookie). */
export async function begun(
  service: SocialLoginService,
  providers: FakeProviders,
  provider: IdentityProvider,
  returnTo: unknown = APP,
): Promise<{ redirect: URL; state: string; cookie: string }> {
  const { redirect, stateCookie } = await service.begin(provider, returnTo);
  const url = new URL(redirect);
  providers.nonce = url.searchParams.get('nonce') ?? '';
  return { redirect: url, state: url.searchParams.get('state') ?? '', cookie: stateCookie };
}

/** A LoginCompleter that records what it was given and answers 303. */
export function recordingCompleter(): LoginCompleter & {
  completed: { userId: string; returnTo: string }[];
} {
  const completed: { userId: string; returnTo: string }[] = [];
  return {
    completed,
    async complete(reply: FastifyReply, userId: string, returnTo: string) {
      completed.push({ userId, returnTo });
      await reply.redirect(returnTo, 303);
    },
  };
}

/** The routes on the API's plugin stack, with captured logs. */
export async function socialApp(
  service: SocialLoginService,
  completer: LoginCompleter = recordingCompleter(),
): Promise<{
  app: FastifyInstance;
  logger: Logger;
  raw: () => string;
  lines: () => Record<string, unknown>[];
}> {
  const captured = captureLogger();
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(socialLoginRoutes, { social: service, completer, logger: captured.logger });
  await app.ready();
  return { app, ...captured };
}
