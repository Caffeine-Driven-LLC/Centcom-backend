/**
 * Relay configuration (B037): the port, the region it serves, the connection cap, the shutdown
 * drain, the transport payload guard and the browser origins it accepts. Read once, at startup, by
 * main.ts (with B004's `baseConfig()` for the host, log level, DATABASE_URL and REDIS_URL).
 *
 * Owns: reading and checking the RELAY_* keys.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** Defaults. */
export const DEFAULT_RELAY_PORT = 8080;
export const DEFAULT_RELAY_MAX_CONNECTIONS = 20_000;
export const DEFAULT_RELAY_SHUTDOWN_DRAIN_MS = 25_000;
export const DEFAULT_RELAY_MAX_TRANSPORT_BYTES = 1_048_576;

const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'must be an origin such as https://app.centcom.dev');

/** The relay's environment keys. */
export const relayEnvSchema = z.object({
  RELAY_PORT: envInt({ min: 1, max: 65_535 }).default(DEFAULT_RELAY_PORT).meta({
    description: 'TCP port of the relay (HTTP health endpoints and /v1/ws).',
    example: '8080',
  }),
  RELAY_REGION: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/, 'must be 1-32 characters of a-z, 0-9 and -')
    .default('local')
    .meta({ description: 'Region this relay serves (logs and metrics).', example: 'eu' }),
  RELAY_MAX_CONNECTIONS: envInt({ min: 1, max: 1_000_000 })
    .default(DEFAULT_RELAY_MAX_CONNECTIONS)
    .meta({
      description: 'Connections one relay holds; one more is closed 4503 (overloaded).',
      example: '20000',
    }),
  RELAY_SHUTDOWN_DRAIN_MS: envInt({ min: 1_000, max: 600_000 })
    .default(DEFAULT_RELAY_SHUTDOWN_DRAIN_MS)
    .meta({
      description: 'Longest wait for connections to close on SIGTERM before they are cut.',
      example: '25000',
    }),
  RELAY_MAX_TRANSPORT_BYTES: envInt({ min: 262_144, max: 16_777_216 })
    .default(DEFAULT_RELAY_MAX_TRANSPORT_BYTES)
    .meta({
      description: 'Largest WebSocket message buffered (the 256 KiB frame rule is separate).',
      example: '1048576',
    }),
  RELAY_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(origin))
    .meta({
      description:
        'Comma-separated browser origins allowed to connect; empty: none (clients without an Origin header only).',
      example: 'https://app.centcom.dev',
    }),
});

/** Checked relay settings. */
export interface RelayConfig {
  port: number;
  region: string;
  maxConnections: number;
  shutdownDrainMs: number;
  maxTransportBytes: number;
  /** Browser origins allowed; empty: only clients that send no Origin. */
  allowedOrigins: readonly string[];
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadRelayConfig(env?: Env): RelayConfig {
  const v = defineConfig(relayEnvSchema, env);
  return {
    port: v.RELAY_PORT,
    region: v.RELAY_REGION,
    maxConnections: v.RELAY_MAX_CONNECTIONS,
    shutdownDrainMs: v.RELAY_SHUTDOWN_DRAIN_MS,
    maxTransportBytes: v.RELAY_MAX_TRANSPORT_BYTES,
    allowedOrigins: v.RELAY_ALLOWED_ORIGINS,
  };
}
