/**
 * Heartbeat configuration (B040, CT-WS-ENVELOPE "Heartbeat"): how often the relay pings
 * (`RELAY_PING_MS`, 20 000) and how long a silent connection lives (`RELAY_DEAD_MS`, 50 000).
 * `sys.welcome` advertises exactly these values (the handshake reads them through
 * `loadHeartbeatConfig` too), so what a client is told is what the relay enforces. An invalid
 * value is a ConfigError and the relay refuses to start.
 *
 * Owns: reading and checking these keys. Must not: allow a dead timeout a pinged client could hit.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** CT-WS-ENVELOPE defaults. */
export const DEFAULT_PING_MS = 20_000;
export const DEFAULT_DEAD_MS = 50_000;

/** The environment keys of the heartbeat. */
export const heartbeatEnvSchema = z
  .object({
    RELAY_PING_MS: envInt({ min: 1_000, max: 300_000 }).default(DEFAULT_PING_MS).meta({
      description: 'Milliseconds between server sys.ping frames (each first ping ±10 %).',
      example: '20000',
    }),
    RELAY_DEAD_MS: envInt({ min: 2_000, max: 900_000 }).default(DEFAULT_DEAD_MS).meta({
      description: 'A connection with no inbound frame for this long is closed (1000, dead_peer).',
      example: '50000',
    }),
  })
  // A client answering every ping must never look dead: at least two pings per dead window.
  .refine((v) => v.RELAY_DEAD_MS >= 2 * v.RELAY_PING_MS, {
    message: 'RELAY_DEAD_MS must be at least twice RELAY_PING_MS',
    path: ['RELAY_DEAD_MS'],
  });

/** Checked heartbeat settings. */
export interface HeartbeatConfig {
  pingMs: number;
  deadMs: number;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadHeartbeatConfig(env?: Env): HeartbeatConfig {
  const values = defineConfig(heartbeatEnvSchema, env);
  return { pingMs: values.RELAY_PING_MS, deadMs: values.RELAY_DEAD_MS };
}

/** `sys.welcome`'s `heartbeat` for `config`. */
export const welcomeHeartbeat = (
  config: HeartbeatConfig,
): { ping_ms: number; dead_ms: number } => ({
  ping_ms: config.pingMs,
  dead_ms: config.deadMs,
});
