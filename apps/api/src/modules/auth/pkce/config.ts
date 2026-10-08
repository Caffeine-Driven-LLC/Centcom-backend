/**
 * Browser sign-in configuration (B018): the redirect URIs each public client may use
 * (`AUTH_REDIRECT_URIS`), the web app's login page (`WEB_LOGIN_URL`) and the origins the web
 * client may call the token endpoint from (`WEB_ALLOWED_ORIGINS`). Every key has a default
 * matching CT-AUTH's production values; an invalid value is a ConfigError, so the API refuses to
 * start.
 *
 * Owns: reading and checking these keys. Must not: start with an allow-list it could not check.
 */
import { defineConfig, envUrl, z, type Env } from '@centcom/core';
import type { ClientId } from '@centcom/db';
import {
  DEFAULT_REDIRECT_URIS,
  readRedirectUris,
  redirectAllowlist,
  type RedirectAllowlist,
} from './redirect-allowlist.js';

/** The web app's login page in production. */
export const DEFAULT_WEB_LOGIN_URL = 'https://app.centcom.dev/login';
/** The web app's origin in production (CT-AUTH "CORS"). */
export const DEFAULT_WEB_ALLOWED_ORIGINS = 'https://app.centcom.dev';
/** The most origins `WEB_ALLOWED_ORIGINS` may list. */
export const MAX_WEB_ORIGINS = 16;

/** Hosts that may be served over plain http (development). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A comma-separated list of origins: `https://host[:port]`, or `http://` on a loopback host. */
const parseOrigins = (value: string, ctx: z.core.$RefinementCtx<string>): string[] => {
  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (origins.length === 0 || origins.length > MAX_WEB_ORIGINS) {
    ctx.addIssue({ code: 'custom', message: `must list 1 to ${MAX_WEB_ORIGINS} origins` });
    return z.NEVER;
  }
  for (const [i, origin] of origins.entries()) {
    let url: URL | undefined;
    try {
      url = new URL(origin);
    } catch {
      url = undefined;
    }
    const allowedScheme =
      url?.protocol === 'https:' || (url?.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
    if (url === undefined || url.origin !== origin || !allowedScheme) {
      ctx.addIssue({
        code: 'custom',
        message: `entry ${i + 1} must be an origin (scheme://host[:port], https unless on a loopback host)`,
      });
      return z.NEVER;
    }
  }
  return origins;
};

/** The environment keys of browser sign-in. */
export const pkceEnvSchema = z.object({
  AUTH_REDIRECT_URIS: z
    .string()
    .default(JSON.stringify(DEFAULT_REDIRECT_URIS))
    .transform((value, ctx): Partial<Record<ClientId, string[]>> => {
      const read = readRedirectUris(value);
      if (read.ok) return read.value;
      ctx.addIssue({ code: 'custom', message: read.problem });
      return z.NEVER;
    })
    .meta({
      description:
        'Redirect URIs per public client, a JSON object {client_id: [uri, ...]}; matched exactly, except that a loopback IP entry without a port (http://127.0.0.1/callback) matches any port.',
      example: '{"centcom-web":["http://localhost:5173/auth/callback"]}',
    }),
  WEB_LOGIN_URL: envUrl({ protocols: ['https:', 'http:'], plain: true })
    .default(DEFAULT_WEB_LOGIN_URL)
    .meta({
      description:
        'The web login page; an unauthenticated authorize request is sent there with a signed return_to.',
      example: 'http://localhost:5173/login',
    }),
  WEB_ALLOWED_ORIGINS: z
    .string()
    .default(DEFAULT_WEB_ALLOWED_ORIGINS)
    .transform(parseOrigins)
    .meta({
      description:
        'Comma-separated origins the web client (centcom-web) may call the token endpoint from.',
      example: 'http://localhost:5173',
    }),
});

/** Checked browser sign-in settings. */
export interface PkceConfig {
  redirects: RedirectAllowlist;
  /** Absolute, without a query or fragment. */
  loginUrl: string;
  allowedOrigins: ReadonlySet<string>;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadPkceConfig(env?: Env): PkceConfig {
  const values = defineConfig(pkceEnvSchema, env);
  return {
    redirects: redirectAllowlist(values.AUTH_REDIRECT_URIS),
    loginUrl: values.WEB_LOGIN_URL,
    allowedOrigins: new Set(values.WEB_ALLOWED_ORIGINS),
  };
}
