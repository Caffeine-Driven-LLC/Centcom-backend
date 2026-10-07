/**
 * Workspace configuration (B027): how many live workspaces one user may own
 * (WORKSPACES_MAX_OWNED, 20 by default). The 21st create is a 409.
 *
 * Owns: reading and checking the key.
 */
import { defineConfig, envInt, z, type Env } from '@centcom/core';

/** The limit when none is configured. */
export const DEFAULT_WORKSPACES_MAX_OWNED = 20;

/** The workspace environment keys. */
export const workspacesEnvSchema = z.object({
  WORKSPACES_MAX_OWNED: envInt({ min: 1, max: 1000 }).default(DEFAULT_WORKSPACES_MAX_OWNED).meta({
    description: 'Live workspaces one user may own; creating one more is a 409.',
    example: '20',
  }),
});

/** Checked workspace settings. */
export interface WorkspacesConfig {
  maxOwned: number;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function loadWorkspacesConfig(env?: Env): WorkspacesConfig {
  return { maxOwned: defineConfig(workspacesEnvSchema, env).WORKSPACES_MAX_OWNED };
}
