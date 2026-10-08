/**
 * Sequencing configuration (B041, CT-WS-ENVELOPE "Limits" and "Sequencing"): the per-member rate
 * limit for sequenced frames (`RELAY_SEQ_RATE` 30/s, `RELAY_SEQ_BURST` 100) and the hot buffer's
 * retention (at least `RELAY_BUF_MIN_FRAMES` 5 000 frames or `RELAY_BUF_MIN_AGE_S` 600 s of them,
 * whichever is more, never over `RELAY_BUF_MAX_FRAMES` 20 000). `sys.welcome` advertises the rate
 * and burst (the handshake reads them here too). An invalid value is a ConfigError and the relay
 * refuses to start.
 *
 * Owns: reading and checking these keys. Must not: allow a buffer floor above its cap.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';
import type { BufferLimits } from './types.js';

/** CT-WS-ENVELOPE defaults. */
export const DEFAULT_SEQ_RATE = 30;
export const DEFAULT_SEQ_BURST = 100;
export const DEFAULT_BUF_MIN_FRAMES = 5_000;
export const DEFAULT_BUF_MIN_AGE_S = 600;
export const DEFAULT_BUF_MAX_FRAMES = 20_000;

/** The environment keys of the sequence module. */
export const seqEnvSchema = z
  .object({
    RELAY_SEQ_RATE: envInt({ min: 1, max: 10_000 }).default(DEFAULT_SEQ_RATE).meta({
      description: 'Sequenced frames per second one member may send, sustained (token refill).',
      example: '30',
    }),
    RELAY_SEQ_BURST: envInt({ min: 1, max: 100_000 }).default(DEFAULT_SEQ_BURST).meta({
      description: 'Sequenced frames one member may send at once (token bucket size).',
      example: '100',
    }),
    RELAY_BUF_MIN_FRAMES: envInt({ min: 1, max: 1_000_000 }).default(DEFAULT_BUF_MIN_FRAMES).meta({
      description: 'Frames each session keeps in the hot buffer at least.',
      example: '5000',
    }),
    RELAY_BUF_MIN_AGE_S: envInt({ min: 0, max: 86_400 }).default(DEFAULT_BUF_MIN_AGE_S).meta({
      description: 'Frames younger than this many seconds stay in the hot buffer (up to the cap).',
      example: '600',
    }),
    RELAY_BUF_MAX_FRAMES: envInt({ min: 1, max: 1_000_000 }).default(DEFAULT_BUF_MAX_FRAMES).meta({
      description: 'Hard cap on the frames a session keeps in the hot buffer.',
      example: '20000',
    }),
  })
  .refine((v) => v.RELAY_BUF_MIN_FRAMES <= v.RELAY_BUF_MAX_FRAMES, {
    message: 'RELAY_BUF_MIN_FRAMES must not exceed RELAY_BUF_MAX_FRAMES',
    path: ['RELAY_BUF_MIN_FRAMES'],
  });

/** Checked sequencing settings. */
export interface SeqConfig {
  /** Sustained sequenced frames per second per member. */
  rate: number;
  /** Token bucket size. */
  burst: number;
  buffer: BufferLimits;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadSeqConfig(env?: Env): SeqConfig {
  const values = defineConfig(seqEnvSchema, env);
  return {
    rate: values.RELAY_SEQ_RATE,
    burst: values.RELAY_SEQ_BURST,
    buffer: {
      minFrames: values.RELAY_BUF_MIN_FRAMES,
      minAgeMs: values.RELAY_BUF_MIN_AGE_S * 1000,
      maxFrames: values.RELAY_BUF_MAX_FRAMES,
    },
  };
}

/** `sys.welcome`'s `limits.seq_rate` and `limits.seq_burst` for `config`. */
export const welcomeSeqLimits = (config: SeqConfig): { seq_rate: number; seq_burst: number } => ({
  seq_rate: config.rate,
  seq_burst: config.burst,
});
