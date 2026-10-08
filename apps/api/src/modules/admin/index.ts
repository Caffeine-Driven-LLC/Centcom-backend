/**
 * Internal admin API (B087): staff access, the audit of every call, and the work behind
 * `/internal/admin/v1` (routes/internal-admin.ts). B089 mounts its search routes with
 * `requireStaff`; B088's console uses the bodies in types.ts. See README.md.
 */
export { ADMIN_AUDIT_ACTIONS, STAFF_ACCESS_ACTION, type AdminAuditAction } from './actions.js';
export {
  ANONYMOUS_ACTOR,
  callEvent,
  newCall,
  outcomeOf,
  type AdminCall,
  type StaffMember,
} from './call.js';
export { cidrMatcher, parseCidr, type Cidr } from './cidr.js';
export {
  ADMIN_BASE,
  ADMIN_RATE_LIMIT,
  ADMIN_RATE_WINDOW_S,
  adminEnvSchema,
  DEFAULT_ADMIN_API_PORT,
  loadAdminConfig,
  STAFF_CACHE_TTL_MS,
  type AdminConfig,
} from './config.js';
export { createLoginGate, loginDisabled } from './login-gate.js';
export type {
  AdminEntitlements,
  AdminTokens,
  FlagAdminPort,
  InviteResender,
  PromotionGranter,
  StaffActor,
  StatusAdminPort,
} from './ports.js';
export { maskEmail, scrub } from './redact.js';
export {
  createAdminStore,
  type AdminReader,
  type AdminStore,
  type AdminStoreDeps,
  type AdminWriter,
  type CallDetails,
} from './repository.js';
export {
  ADMIN_DETAILS,
  AdminService,
  MAX_WORKSPACE_MEMBERS,
  NotWiredError,
  STAFF_AUDIT_DEFAULT_LIMIT,
  STAFF_AUDIT_MAX_LIMIT,
  type AdminServiceDeps,
  type AfterCommit,
} from './service.js';
export {
  checkStaff,
  requireStaff,
  roleAtLeast,
  STAFF_DETAILS,
  StaffDirectory,
  validReason,
  validTicket,
  type AdminAccess,
  type StaffDirectoryDeps,
} from './staff.js';
export * from './types.js';
