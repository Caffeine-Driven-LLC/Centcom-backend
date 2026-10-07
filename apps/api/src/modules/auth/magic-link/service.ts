/**
 * E-mail sign-in (B014): `request` e-mails a one-time link, `consume` turns one into a user.
 *
 * - **No account enumeration:** a request does the same work whatever the address (no account is
 *   looked up), and the mail goes out after the response, in the background. Valid addresses are
 *   all treated alike; an account is found, or created, only when a link is used.
 * - **Links:** a 256-bit token (only its sha256 is stored), bound to the requesting browser's
 *   nonce, valid MAGIC_LINK_TTL_S (15 minutes), used at most once.
 * - **Limits:** 5 links per address per hour; past it, nothing is sent and the caller cannot tell.
 *   The 20/min per address cap is the rate limiter's auth bucket (B023), set on the routes.
 * - **Accounts:** `pending_deletion` and `deleted` accounts fail to sign in like a bad link.
 * - **Failures:** a mail that cannot be sent after 3 attempts gives its link up (counted and
 *   logged); the token store down is a 503 with `retry_after_s`.
 *
 * Owns: the flow. Must not: reveal whether an address has an account, store or log a token, link,
 * nonce or address (logs carry `usr_` ids and hashed-address prefixes).
 */
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleepFor } from 'node:timers/promises';
import {
  isAppError,
  noopMetrics,
  unavailable,
  validationFailed,
  type Logger,
  type Metrics,
  type RateLimitStore,
} from '@centcom/core';
import type { User } from '@centcom/db';
import { checkEmail } from '../../users/index.js';
import type { ReturnToPolicy } from '../return-to.js';
import { DEFAULT_MAGIC_LINK_TTL_S } from './config.js';
import type { MagicLinkMailer } from './mailer.js';
import type { LoginTokenStore } from './store.js';

/** Links one address may ask for... */
export const LINKS_PER_EMAIL = 5;
/** ...per this many seconds. */
export const LINKS_WINDOW_S = 60 * 60;
/** Attempts to hand a link to the mailer. */
export const MAIL_ATTEMPTS = 3;
/** Tokens and nonces: 32 random bytes, base64url. */
export const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const MAGIC_LINK_DETAILS = Object.freeze({
  invalidEmail: 'Enter a valid e-mail address.',
  unavailable: 'Sign-in links cannot be sent right now. Try again in a moment.',
} as const);

/** A link that cannot sign anyone in: unknown, used, expired, from another browser, or a closed account. */
export class MagicLinkError extends Error {
  override name = 'MagicLinkError';
  constructor() {
    super('the sign-in link is not valid');
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
/** A 32-byte secret, base64url (tokens and nonces). */
export const newSecret = (): string => randomBytes(32).toString('base64url');
/** How logs name an address: the first 12 hex digits of its sha256. */
export const emailHashPrefix = (address: string): string => sha256(address).slice(0, 12);

/** Options for MagicLinkService. */
export interface MagicLinkServiceOptions {
  store: LoginTokenStore;
  mailer: MagicLinkMailer;
  /** B013's UserService. */
  users: { getOrCreateByEmail(email: string): Promise<{ user: Pick<User, 'id' | 'status'> }> };
  /** The per-address limit (B009 `RedisBackend.rateLimit`). */
  rateLimit: RateLimitStore;
  returnTo: ReturnToPolicy;
  /** MAGIC_LINK_BASE_URL, without a trailing slash. */
  baseUrl: string;
  /** MAGIC_LINK_TTL_S; default 900. */
  ttlS?: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Waits between mail attempts; default a timer (1 s, then 2 s, with jitter). */
  sleep?: (ms: number) => Promise<void>;
  /** Writes `auth.magic_link_*` lines (hashed-address prefixes and `usr_` ids only). */
  logger?: Logger;
  /**
   * Receives `magic_link_requests_total`, `magic_link_limited_total`, `magic_link_mail_failures_total`,
   * `magic_link_logins_total` and `magic_link_failures_total`.
   */
  metrics?: Metrics;
}

/** E-mail sign-in links. */
export class MagicLinkService {
  readonly #o: MagicLinkServiceOptions;
  readonly #ttlS: number;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #metrics: Metrics;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: MagicLinkServiceOptions) {
    this.#o = options;
    this.#ttlS = options.ttlS ?? DEFAULT_MAGIC_LINK_TTL_S;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => sleepFor(ms).then(() => undefined));
    this.#metrics = options.metrics ?? noopMetrics;
  }

  /** Token store and limiter failures are a 503: no link is better than an unrecorded one. */
  async #guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw unavailable(1, MAGIC_LINK_DETAILS.unavailable);
    }
  }

  /**
   * E-mails a sign-in link for `email` to it, in the background, bound to the browser's `nonce`
   * and returning to `returnTo` when allow-listed. Resolves the same way for every valid address;
   * throws a 422 for one that is not an address, a 503 when the store is down.
   */
  async request(
    email: unknown,
    ctx: { nonce: string; locale: string; returnTo?: unknown },
  ): Promise<void> {
    const checked = checkEmail(email, '/email');
    if (checked.value === undefined) {
      throw validationFailed(checked.issues, MAGIC_LINK_DETAILS.invalidEmail);
    }
    if (!SECRET_SHAPE.test(ctx.nonce)) throw new TypeError('request: the nonce is malformed');
    const address = checked.value;
    const emailHash = sha256(address);
    this.#metrics.counter('magic_link_requests_total').inc();
    const limit = await this.#guarded(() =>
      this.#o.rateLimit.consume(`magic:email:${emailHash}`, LINKS_PER_EMAIL, LINKS_WINDOW_S),
    );
    if (!limit.allowed) {
      this.#metrics.counter('magic_link_limited_total').inc();
      this.#o.logger?.info({ email_hash: emailHash.slice(0, 12) }, 'auth.magic_link_limited');
      return;
    }
    const token = newSecret();
    const tokenHash = sha256(token);
    await this.#guarded(() =>
      this.#o.store.insert({
        tokenHash,
        nonceHash: sha256(ctx.nonce),
        email: address,
        returnTo: this.#o.returnTo.resolve(ctx.returnTo),
        expiresAt: new Date(this.#clock() + this.#ttlS * 1000),
      }),
    );
    const link = `${this.#o.baseUrl}/login/email/verify?t=${token}`;
    const delivery = this.#deliver(address, link, tokenHash, ctx.locale);
    this.#pending.add(delivery);
    void delivery.finally(() => this.#pending.delete(delivery));
  }

  /** Hands the link to the mailer, up to MAIL_ATTEMPTS times; gives the link up if all fail. */
  async #deliver(address: string, link: string, tokenHash: string, locale: string): Promise<void> {
    const emailHash = emailHashPrefix(address);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#o.mailer.send(address, link, locale);
        this.#o.logger?.info({ email_hash: emailHash }, 'auth.magic_link_sent');
        return;
      } catch (err) {
        // A 4xx from the email service (refused address, its own limit) will not change on retry.
        const permanent = isAppError(err) && err.status < 500;
        if (permanent || attempt >= MAIL_ATTEMPTS) break;
        await this.#sleep(1000 * 2 ** (attempt - 1) * (0.5 + Math.random() / 2));
      }
    }
    this.#metrics.counter('magic_link_mail_failures_total').inc();
    this.#o.logger?.error({ email_hash: emailHash }, 'auth.magic_link_mail_failed');
    await this.#o.store.invalidate(tokenHash, new Date(this.#clock())).catch(() => {
      this.#o.logger?.error({ email_hash: emailHash }, 'auth.magic_link_invalidate_failed');
    });
  }

  /** Resolves once every mail this service started has been handed over or given up. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  /**
   * The user `token` signs in, from the browser with `nonce`, and where to send them: the account
   * is found or created by the link's address. Throws a MagicLinkError for any link that cannot
   * sign in (one error for every reason), a 503 when the store is down.
   */
  async consume(token: unknown, nonce: unknown): Promise<{ userId: string; returnTo: string }> {
    if (typeof token !== 'string' || typeof nonce !== 'string') return this.#fail('malformed');
    if (!SECRET_SHAPE.test(token) || !SECRET_SHAPE.test(nonce)) return this.#fail('malformed');
    const used = await this.#guarded(() =>
      this.#o.store.consume(sha256(token), sha256(nonce), new Date(this.#clock())),
    );
    if (used === null) return this.#fail('unknown');
    const { user } = await this.#o.users.getOrCreateByEmail(used.email);
    if (user.status !== 'active') return this.#fail('account_closed', user.id);
    this.#metrics.counter('magic_link_logins_total').inc();
    this.#o.logger?.info({ user_id: user.id }, 'auth.magic_link_login');
    return { userId: user.id, returnTo: this.#o.returnTo.resolve(used.returnTo) };
  }

  /** Counts and logs why a link failed (the user only ever sees one generic error). */
  #fail(reason: 'malformed' | 'unknown' | 'account_closed', userId?: string): never {
    this.#metrics.counter('magic_link_failures_total', { reason }).inc();
    this.#o.logger?.info(
      { reason, ...(userId === undefined ? {} : { user_id: userId }) },
      'auth.magic_link_failed',
    );
    throw new MagicLinkError();
  }
}
