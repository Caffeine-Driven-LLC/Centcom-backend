/**
 * Test helpers for the API entrypoint (B102): an environment the config loader accepts, a
 * browser with a cookie jar over `app.inject`, and a mailer that keeps the links it was given.
 */
import { createMemoryRedis, type Env } from '@centcom/core';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { generateSigningJwk } from '../../src/modules/auth/tokens/keys.js';
import type { MagicLinkMailer } from '../../src/modules/auth/magic-link/mailer.js';

export const BASE = 'http://localhost:3000';

/** A complete, valid environment for `loadApiConfig`; `overrides` replace or (with undefined) drop keys. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    SERVICE_NAME: 'api',
    PUBLIC_API_URL: BASE,
    DATABASE_URL: 'postgres://centcom:test@127.0.0.1:1/centcom_test',
    REDIS_URL: 'redis://127.0.0.1:1/0',
    CURSOR_SIGNING_KEYS: 'test:0123456789abcdef0123456789abcdef',
    AUTH_SIGNING_KEYS: JSON.stringify([generateSigningJwk('t1')]),
    AUTH_SIGNING_KID: 't1',
    DEV_MAILPIT_URL: 'http://127.0.0.1:1',
    MAGIC_LINK_BASE_URL: BASE,
    LOGIN_RETURN_TO_ALLOWLIST: `${BASE}/`,
    DEVICE_VERIFICATION_URI: `${BASE}/device`,
    EXPECTED_MIGRATION_VERSION: '',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
}

/** In-memory Redis on a clock. */
export const memoryRedis = (now: () => number = Date.now) => createMemoryRedis(now);

/** A mailer that keeps what it was asked to send. */
export function captureMailer(): MagicLinkMailer & { sent: { to: string; link: string }[] } {
  const sent: { to: string; link: string }[] = [];
  return {
    sent,
    send(to, link) {
      sent.push({ to, link });
      return Promise.resolve();
    },
  };
}

/** What a browser keeps between requests: cookies by name. */
export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  #cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #keep(res: LightMyRequestResponse): void {
    const set = res.headers['set-cookie'];
    for (const line of Array.isArray(set) ? set : set === undefined ? [] : [set]) {
      const [pair = '', ...attrs] = line.split('; ');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
      if (value === '' || maxAge?.slice(8) === '0') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async get(url: string): Promise<LightMyRequestResponse> {
    const cookie = this.#cookieHeader();
    const res = await this.app.inject({
      method: 'GET',
      url,
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
    this.#keep(res);
    return res;
  }

  async post(
    url: string,
    form: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const cookie = this.#cookieHeader();
    const res = await this.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === undefined ? {} : { cookie }),
        ...headers,
      },
      payload: new URLSearchParams(form).toString(),
    });
    this.#keep(res);
    return res;
  }

  /** Follows one redirect. */
  async follow(res: LightMyRequestResponse): Promise<LightMyRequestResponse> {
    const location = res.headers['location'];
    if (typeof location !== 'string') throw new Error('not a redirect');
    return this.get(location.replace(BASE, ''));
  }
}

/** The value of a hidden form field in a page. */
export function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no field ${name} in the page`);
  return match[1];
}
