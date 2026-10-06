/**
 * Base configuration (B004): the keys every service reads. Per-feature keys (JWT, Stripe, R2,
 * e-mail, ...) are declared by the lane that uses them, in its own module, with `defineConfig`.
 *
 * Owns: NODE_ENV, SERVICE_NAME, LOG_LEVEL, HOST, PORT, PUBLIC_API_URL, DATABASE_URL, REDIS_URL,
 * TRUSTED_PROXY_HOPS, REQUEST_TIMEOUT_MS, ALLOW_INSECURE_BACKENDS and the production TLS rules.
 */
import { z } from 'zod';
import {
  defineConfig,
  envBool,
  envInt,
  envUrl,
  type DeepReadonly,
  type DefineConfigOptions,
  type Env,
} from './define.js';
import { secretString } from './secret.js';

/** Allowed NODE_ENV values. Anything else is rejected, never mapped to `development`. */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
/** A runtime mode. */
export type NodeEnv = (typeof NODE_ENVS)[number];

/** Log levels, most to least severe; `silent` turns logging off (tests). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** A log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** sslmode values that require TLS to Postgres. */
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/** The environment keys, with documentation metadata (rendered into docs/config.md and .env.example). */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).meta({
    description:
      'Runtime mode. Required; unknown values are rejected (never treated as development).',
    example: 'development',
  }),
  SERVICE_NAME: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{1,39}$/,
      'must be 2-40 characters of a-z, 0-9 and -, starting with a letter',
    )
    .meta({
      description: 'Service name for logs and metrics, e.g. api, relay, worker.',
      example: 'api',
      envType: 'string',
    }),
  LOG_LEVEL: z
    .enum(LOG_LEVELS)
    .default('info')
    .meta({ description: 'Minimum log level.', example: 'info' }),
  HOST: z
    .string()
    .regex(/^[A-Za-z0-9.:-]{1,253}$/, 'must be a host name or IP address')
    .default('127.0.0.1')
    .meta({
      description: 'Interface to listen on. Set 0.0.0.0 (or ::) in containers.',
      example: '127.0.0.1',
      envType: 'host or IP',
    }),
  PORT: envInt({ min: 1, max: 65535 })
    .default(3000)
    .meta({ description: 'TCP port to listen on.', example: '3000' }),
  PUBLIC_API_URL: envUrl({ protocols: ['http:', 'https:'], plain: true })
    .transform((url) => url.replace(/\/+$/, ''))
    .meta({
      description: 'Public base URL of the REST API, used in links. Trailing slashes are removed.',
      example: 'http://localhost:3000',
    }),
  DATABASE_URL: secretString(envUrl({ protocols: ['postgres:', 'postgresql:'] })).meta({
    description:
      'Postgres connection URL. In production it must set sslmode=require (or verify-ca / verify-full).',
    example: 'postgres://centcom:centcom@localhost:5432/centcom',
  }),
  REDIS_URL: secretString(envUrl({ protocols: ['redis:', 'rediss:'] })).meta({
    description: 'Redis connection URL. In production it must use rediss:// (TLS).',
    example: 'redis://localhost:6379/0',
  }),
  TRUSTED_PROXY_HOPS: envInt({ min: 0, max: 10 }).default(1).meta({
    description:
      'Number of reverse proxies in front of the service whose X-Forwarded-For is trusted.',
    example: '1',
  }),
  REQUEST_TIMEOUT_MS: envInt({ min: 100, max: 600_000 }).default(30_000).meta({
    description: 'Server-side timeout for one request, in milliseconds.',
    example: '30000',
  }),
  ALLOW_INSECURE_BACKENDS: envBool().default(false).meta({
    description: 'Allows plain-text Postgres and Redis in production. For emergencies only.',
    example: '0',
  }),
});

type BaseEnv = z.output<typeof baseEnvSchema>;

const insecureForbidden = (v: BaseEnv): boolean =>
  v.NODE_ENV === 'production' && !v.ALLOW_INSECURE_BACKENDS;

/** Run a cross-field rule whenever the keys it reads are valid, whatever else failed. */
const whenValid =
  (...keys: string[]) =>
  (payload: { issues: ReadonlyArray<{ path?: readonly PropertyKey[] }> }): boolean =>
    payload.issues.every((issue) => !keys.includes(String(issue.path?.[0])));

/** The full base schema: environment keys, production TLS rules, camel-case config object. */
export const baseSchema = baseEnvSchema
  .refine(
    (v) =>
      !insecureForbidden(v) ||
      TLS_SSLMODES.has(new URL(v.DATABASE_URL.reveal()).searchParams.get('sslmode') ?? ''),
    {
      path: ['DATABASE_URL'],
      message:
        'must set sslmode=require (or verify-ca, verify-full) in production; ALLOW_INSECURE_BACKENDS=1 overrides',
      when: whenValid('NODE_ENV', 'ALLOW_INSECURE_BACKENDS', 'DATABASE_URL'),
    },
  )
  .refine((v) => !insecureForbidden(v) || new URL(v.REDIS_URL.reveal()).protocol === 'rediss:', {
    path: ['REDIS_URL'],
    message: 'must use rediss:// (TLS) in production; ALLOW_INSECURE_BACKENDS=1 overrides',
    when: whenValid('NODE_ENV', 'ALLOW_INSECURE_BACKENDS', 'REDIS_URL'),
  })
  .transform((v) => ({
    nodeEnv: v.NODE_ENV,
    serviceName: v.SERVICE_NAME,
    logLevel: v.LOG_LEVEL,
    host: v.HOST,
    port: v.PORT,
    publicApiUrl: v.PUBLIC_API_URL,
    databaseUrl: v.DATABASE_URL,
    redisUrl: v.REDIS_URL,
    trustedProxyHops: v.TRUSTED_PROXY_HOPS,
    requestTimeoutMs: v.REQUEST_TIMEOUT_MS,
    allowInsecureBackends: v.ALLOW_INSECURE_BACKENDS,
  }));

/** The parsed base configuration (deep-frozen). */
export type BaseConfig = DeepReadonly<z.output<typeof baseSchema>>;

/**
 * Loads the base configuration from `env` (default `process.env`). Call once, in the service's
 * entrypoint, and pass the result on; throws ConfigError listing every invalid key.
 */
export function baseConfig(env?: Env, options?: DefineConfigOptions): BaseConfig {
  return defineConfig(baseSchema, env, options);
}
