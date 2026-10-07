/**
 * Workspaces (B027, CT-API-WORKSPACES): the CRUD routes, the service behind them, request bodies
 * and the PATCH extension registry (B034 adds `settings` through it), slugs, and configuration.
 * The purge job and its hook registry are in @centcom/worker; the SQL in @centcom/db.
 */
export { actorOf, ctxOf, readerOf, UNAUTHENTICATED_DETAIL, workspaceAccess } from './access.js';
export {
  DEFAULT_WORKSPACES_MAX_OWNED,
  loadWorkspacesConfig,
  workspacesEnvSchema,
  type WorkspacesConfig,
} from './config.js';
export {
  createPatchExtensionRegistry,
  INVALID_BODY_DETAIL,
  parseCreate,
  parseUpdate,
  type CreateInput,
  type PatchExtension,
  type PatchExtensionRegistry,
  type UpdateInput,
} from './input.js';
export { FALLBACK_SLUG, nextSlug, SLUG_BASE_MAX, slugFromName } from './slug.js';
export {
  SLUG_ATTEMPTS,
  WORKSPACE_DETAILS,
  WorkspaceService,
  type PurgeQueue,
  type Reader,
  type RequestCtx,
  type WorkspaceServiceOptions,
} from './service.js';
export {
  WORKSPACE_ROUTE_DETAILS,
  workspaceBody,
  workspaceRoutes,
  type WorkspaceRouteOptions,
} from './routes.js';
