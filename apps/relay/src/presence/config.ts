/**
 * Presence configuration (B047, CT-WS-PRESENCE):
 *
 * | Key | Default | |
 * |---|---|---|
 * | `RELAY_PRESENCE_IN_MS` | 1 000 | A member's updates are taken at most this often (more are coalesced). |
 * | `RELAY_PRESENCE_OUT_MS` | 500 | A member's presence goes out at most this often. |
 * | `RELAY_OFFLINE_GRACE_MS` | 10 000 | A member stays online this long after its last connection closed. |
 *
 * Owns: reading and checking these keys.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';
import type { PresenceConfig } from './service.js';

/** Card defaults. */
export const DEFAULT_PRESENCE_IN_MS = 1_000;
export const DEFAULT_PRESENCE_OUT_MS = 500;
export const DEFAULT_OFFLINE_GRACE_MS = 10_000;

/** The environment keys of the presence module. */
export const presenceEnvSchema = z.object({
  RELAY_PRESENCE_IN_MS: envInt({ min: 0, max: 60_000 }).default(DEFAULT_PRESENCE_IN_MS).meta({
    description: "Milliseconds between a member's presence updates taken (more are coalesced).",
    example: '1000',
  }),
  RELAY_PRESENCE_OUT_MS: envInt({ min: 0, max: 60_000 }).default(DEFAULT_PRESENCE_OUT_MS).meta({
    description: "Milliseconds between a member's presence frames sent out, at least.",
    example: '500',
  }),
  RELAY_OFFLINE_GRACE_MS: envInt({ min: 0, max: 600_000 }).default(DEFAULT_OFFLINE_GRACE_MS).meta({
    description: 'Milliseconds a member stays online after its last connection closed.',
    example: '10000',
  }),
});

/** Reads the settings (default: the process environment, through the config loader). */
export function loadPresenceConfig(env?: Env): PresenceConfig {
  const v = defineConfig(presenceEnvSchema, env);
  return {
    inMs: v.RELAY_PRESENCE_IN_MS,
    outMs: v.RELAY_PRESENCE_OUT_MS,
    offlineGraceMs: v.RELAY_OFFLINE_GRACE_MS,
  };
}
