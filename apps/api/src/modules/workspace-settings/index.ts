/**
 * Workspace settings (B034, CT-API-WORKSPACES): the routes, the service behind them (also the
 * `settings` field of B027's workspace PATCH), the body parser, ETags and the entitlements port.
 * The SQL is `createWorkspaceSettingsStore` in @centcom/db; the purge hook is in @centcom/worker.
 */
export {
  FREE_PLAN_HISTORY_DAYS,
  freePlanHistoryDays,
  type HistoryDaysReader,
} from './entitlements.js';
export { parseSettingsIfMatch, settingsEtag } from './etag.js';
export {
  AUTO_APPROVE_LEVELS,
  checkSettingsPatch,
  INVALID_SETTINGS_DETAIL,
  MAX_RETENTION_DAYS,
  parseSettingsPatch,
  SETTINGS_KEYS,
  type SettingsKey,
  type SettingsPatch,
  type WorkspaceSettings,
} from './input.js';
export {
  DEFAULT_WORKSPACE_SETTINGS,
  SETTINGS_DETAILS,
  SETTINGS_PUBLISH_ATTEMPTS,
  SETTINGS_PUBLISH_BACKOFF_MS,
  WorkspaceSettingsService,
  type SettingsView,
  type WorkspaceSettingsServiceOptions,
} from './service.js';
export {
  SETTINGS_ROUTE_DETAILS,
  workspaceSettingsRoutes,
  type WorkspaceSettingsRouteOptions,
} from './routes.js';
