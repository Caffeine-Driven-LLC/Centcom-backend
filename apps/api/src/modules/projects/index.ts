/**
 * Workspace projects (B035, CT-API-WORKSPACES): the routes, `ProjectService` and the request
 * bodies. The SQL is `createProjectStore` in @centcom/db; the purge hook is
 * `registerProjectPurgeHook` in @centcom/worker.
 */
export {
  checkRepoRef,
  INVALID_PROJECT_BODY_DETAIL,
  MAX_REPO_REF_LENGTH,
  parseProjectCreate,
  parseProjectUpdate,
  type ProjectInput,
  type ProjectPatch,
} from './input.js';
export {
  PROJECT_AUDIT_FIELD,
  PROJECT_DETAILS,
  ProjectService,
  type ProjectServiceOptions,
} from './service.js';
export {
  PROJECT_ACTIONS,
  PROJECT_ROUTE_DETAILS,
  projectBody,
  projectRoutes,
  type ProjectRouteOptions,
} from './routes.js';
