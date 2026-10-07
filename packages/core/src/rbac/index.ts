/**
 * RBAC (B021, CT-RBAC): the one engine for authorisation. The action catalogue, the permission
 * matrix as data, the pure `can`, `authorize` over membership state with audited denials, scope
 * checks, and the 2 s membership cache with `rbac:invalidate`. Route code calls these and never
 * compares role strings itself.
 */
export {
  ACTIONS,
  defaultSessionRole,
  isAction,
  isSessionRole,
  isWorkspaceRole,
  SESSION_ACTIONS,
  SESSION_ROLES,
  WORKSPACE_ACTIONS,
  WORKSPACE_ROLES,
  type Action,
  type SessionAction,
  type SessionRole,
  type WorkspaceAction,
  type WorkspaceRole,
} from './actions.js';
export {
  can,
  createAuthorizer,
  FORBIDDEN_DETAIL,
  type Actor,
  type AuditSink,
  type AuthorizeOptions,
  type Authorizer,
  type AuthorizerDeps,
  type CanContext,
  type Decision,
  type DenyReason,
  type RbacDeniedEvent,
  type Resource,
} from './can.js';
export {
  MATRIX,
  ORDINARY_ROLES,
  ruleOf,
  type Condition,
  type SessionRule,
  type WorkspaceRule,
} from './matrix.js';
export {
  cachedMembershipReader,
  MEMBERSHIP_CACHE_MAX_ENTRIES,
  MEMBERSHIP_CACHE_TTL_MS,
  publishInvalidation,
  RBAC_INVALIDATE_CHANNEL,
  subscribeInvalidations,
  type CachedMembershipReader,
  type Invalidation,
  type MembershipReader,
} from './membership.js';
export { hasScope, hasScopes, isScope, SCOPES, type Scope, type ScopeHolder } from './scopes.js';
