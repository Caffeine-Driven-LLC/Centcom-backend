/**
 * The admin console's settings (B088). The admin API base comes from `VITE_ADMIN_API_BASE` at
 * build time (vite.config.ts); the routes live under `/internal/admin/v1` there (B087).
 */

/** Where the admin routes live on the admin API. */
export const ADMIN_PATH = '/internal/admin/v1';

/** Signed out after this long without activity. */
export const IDLE_SIGN_OUT_MS = 15 * 60 * 1000;

/** What the console is started with. */
export interface ConsoleConfig {
  /** The admin API's base URL ('' for the console's own origin). */
  apiBase: string;
  /** Default IDLE_SIGN_OUT_MS. */
  idleMs?: number;
}
