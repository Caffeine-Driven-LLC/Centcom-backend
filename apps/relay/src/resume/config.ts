/**
 * Resume configuration (B042):
 *
 * | Key | Default | |
 * |---|---|---|
 * | `RELAY_REPLAY_BATCH` | 100 | Frames read per replay batch (1 to 1 000). |
 * | `RELAY_REPLAY_MAX_FRAMES` | 50 000 | A longer replay window is answered with `snapshot_required`. |
 * | `RELAY_HYDRATE_FRAMES` | 5 000 | Newest frames put back in the hot buffer when a session is recovered. |
 * | `OBJECT_STORE_*` | | The durable log's object store (`@centcom/storage`); all or none. |
 *
 * Without `OBJECT_STORE_*` the relay has no durable log: frames are not stored, replay comes from the
 * hot buffer only and nothing is recovered after a Redis flush. That is refused in production
 * (`NODE_ENV=production`), where a session must never restart at `seq` 1.
 *
 * Owns: reading and checking these keys. Must not: put a secret in an error.
 */
import { baseConfig, ConfigError, defineConfig, envInt, z, type Env } from '@centcom/core';
import {
  loadObjectStoreConfig,
  objectStoreEnvSchema,
  type ObjectStoreConfig,
} from '@centcom/storage';

/** Card defaults. */
export const DEFAULT_REPLAY_BATCH = 100;
export const DEFAULT_REPLAY_MAX_FRAMES = 50_000;
export const DEFAULT_HYDRATE_FRAMES = 5_000;

/** The environment keys of the resume module (the object store's are `@centcom/storage`'s). */
export const resumeEnvSchema = z.object({
  RELAY_REPLAY_BATCH: envInt({ min: 1, max: 1_000 }).default(DEFAULT_REPLAY_BATCH).meta({
    description: 'Frames read and sent per replay batch.',
    example: '100',
  }),
  RELAY_REPLAY_MAX_FRAMES: envInt({ min: 1, max: 1_000_000 })
    .default(DEFAULT_REPLAY_MAX_FRAMES)
    .meta({
      description: 'Longest replay; a resume further behind is answered with snapshot_required.',
      example: '50000',
    }),
  RELAY_HYDRATE_FRAMES: envInt({ min: 0, max: 20_000 }).default(DEFAULT_HYDRATE_FRAMES).meta({
    description: 'Newest frames put back in the hot buffer when a lost session is recovered.',
    example: '5000',
  }),
});

/** Checked resume settings. */
export interface ResumeConfig {
  batch: number;
  maxFrames: number;
  hydrateFrames: number;
  /** The durable log's object store; null when none is configured (never in production). */
  objectStore: ObjectStoreConfig | null;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadResumeConfig(env?: Env): ResumeConfig {
  const v = defineConfig(resumeEnvSchema, env);
  // OBJECT_STORE_REGION has a default: the other keys say whether a store is configured.
  const store = defineConfig(objectStoreEnvSchema.partial(), env);
  const configured = (
    [
      'OBJECT_STORE_ENDPOINT',
      'OBJECT_STORE_BUCKET',
      'OBJECT_STORE_ACCESS_KEY_ID',
      'OBJECT_STORE_SECRET_ACCESS_KEY',
    ] as const
  ).some((key) => store[key] !== undefined);
  if (!configured && baseConfig(env).nodeEnv === 'production') {
    throw new ConfigError([
      {
        key: 'OBJECT_STORE_ENDPOINT',
        problem: 'is required in production: the relay keeps every frame in the durable log',
      },
    ]);
  }
  return {
    batch: v.RELAY_REPLAY_BATCH,
    maxFrames: v.RELAY_REPLAY_MAX_FRAMES,
    hydrateFrames: v.RELAY_HYDRATE_FRAMES,
    objectStore: configured ? loadObjectStoreConfig(env) : null,
  };
}
