/**
 * Cluster configuration (B045):
 *
 * | Key | Default | |
 * |---|---|---|
 * | `RELAY_NODE_ID` | a random ULID | This node's name in cluster messages and `relay:node:{id}` (1 to 64 of `A-Za-z0-9_-`). |
 * | `RELAY_CLUSTER_GAP_MS` | 250 | How long frames wait for a missing one before it is fetched from the hot buffer. |
 * | `RELAY_UNSUB_GRACE_MS` | 30 000 | A session's channels are left this long after its last local connection. |
 * | `RELAY_CLUSTER_RECONCILE_MS` | 5 000 | How often each subscribed session is checked against the store's head (0: never). |
 *
 * Owns: reading and checking these keys.
 */
import { newId } from '@centcom/contracts';
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** Card defaults. */
export const DEFAULT_CLUSTER_GAP_MS = 250;
export const DEFAULT_UNSUB_GRACE_MS = 30_000;
export const DEFAULT_RECONCILE_MS = 5_000;

/** The environment keys of the cluster module. */
export const clusterEnvSchema = z.object({
  RELAY_NODE_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1 to 64 letters, digits, _ or -')
    .optional()
    .meta({
      description: "This node's id in cluster messages; default a random ULID.",
      example: 'relay-eu-1',
    }),
  RELAY_CLUSTER_GAP_MS: envInt({ min: 10, max: 10_000 }).default(DEFAULT_CLUSTER_GAP_MS).meta({
    description: 'Milliseconds frames wait for a missing one before the hot buffer fills the gap.',
    example: '250',
  }),
  RELAY_UNSUB_GRACE_MS: envInt({ min: 0, max: 600_000 }).default(DEFAULT_UNSUB_GRACE_MS).meta({
    description: "Milliseconds a session's channels are kept after its last local connection left.",
    example: '30000',
  }),
  RELAY_CLUSTER_RECONCILE_MS: envInt({ min: 0, max: 600_000 }).default(DEFAULT_RECONCILE_MS).meta({
    description:
      'Milliseconds between checks of each subscribed session against the head (0: off).',
    example: '5000',
  }),
});

/** Checked cluster settings. */
export interface ClusterConfig {
  nodeId: string;
  gapMs: number;
  unsubGraceMs: number;
  reconcileMs: number;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadClusterConfig(env?: Env): ClusterConfig {
  const v = defineConfig(clusterEnvSchema, env);
  return {
    // A bare ULID: the id generator's, without its prefix.
    nodeId: v.RELAY_NODE_ID ?? newId('req').slice(4),
    gapMs: v.RELAY_CLUSTER_GAP_MS,
    unsubGraceMs: v.RELAY_UNSUB_GRACE_MS,
    reconcileMs: v.RELAY_CLUSTER_RECONCILE_MS,
  };
}
