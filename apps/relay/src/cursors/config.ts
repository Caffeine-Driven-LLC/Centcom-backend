/**
 * Cursor and typing configuration (B048, CT-WS-PRESENCE):
 *
 * | Key | Default | |
 * |---|---|---|
 * | `RELAY_CURSOR_IN_PER_S` | 10 | Cursor frames a member may send per second (more are dropped). |
 * | `RELAY_CURSOR_TICK_MS` | 100 | How often the latest cursor of each member that changed goes out. |
 * | `RELAY_TYPING_TTL_MS` | 5 000 | A typing indicator not refreshed for this long is cleared by the relay. |
 * | `RELAY_CURSOR_MAX_CT_BYTES` | 4 096 | Largest cursor `ct` (serialised); larger is `invalid_frame`. |
 *
 * Owns: reading and checking these keys.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** Card defaults. */
export const DEFAULT_CURSOR_IN_PER_S = 10;
export const DEFAULT_CURSOR_TICK_MS = 100;
export const DEFAULT_TYPING_TTL_MS = 5_000;
export const DEFAULT_CURSOR_MAX_CT_BYTES = 4_096;

/** The environment keys of the cursors module. */
export const cursorsEnvSchema = z.object({
  RELAY_CURSOR_IN_PER_S: envInt({ min: 1, max: 1_000 }).default(DEFAULT_CURSOR_IN_PER_S).meta({
    description: 'Cursor frames a member may send per second; more are dropped.',
    example: '10',
  }),
  RELAY_CURSOR_TICK_MS: envInt({ min: 10, max: 10_000 }).default(DEFAULT_CURSOR_TICK_MS).meta({
    description: 'Milliseconds between cursor fan-outs (the latest per member that changed).',
    example: '100',
  }),
  RELAY_TYPING_TTL_MS: envInt({ min: 100, max: 600_000 }).default(DEFAULT_TYPING_TTL_MS).meta({
    description: 'Milliseconds after which a typing indicator not refreshed is cleared.',
    example: '5000',
  }),
  RELAY_CURSOR_MAX_CT_BYTES: envInt({ min: 64, max: 65_536 })
    .default(DEFAULT_CURSOR_MAX_CT_BYTES)
    .meta({ description: 'Largest serialised ct of a cursor frame, in bytes.', example: '4096' }),
});

/** Checked settings. */
export interface CursorsConfig {
  inPerSecond: number;
  tickMs: number;
  typingTtlMs: number;
  maxCtBytes: number;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadCursorsConfig(env?: Env): CursorsConfig {
  const v = defineConfig(cursorsEnvSchema, env);
  return {
    inPerSecond: v.RELAY_CURSOR_IN_PER_S,
    tickMs: v.RELAY_CURSOR_TICK_MS,
    typingTtlMs: v.RELAY_TYPING_TTL_MS,
    maxCtBytes: v.RELAY_CURSOR_MAX_CT_BYTES,
  };
}
