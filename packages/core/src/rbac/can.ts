/**
 * Decisions (B021, CT-RBAC): `can` answers one question from the matrix, purely; `authorize`
 * loads the actor's roles from server-side membership state, asks `can`, and on a denial records
 * an audit event (privileged actions, rule 6) and throws 403 `forbidden`.
 *
 * Owns: every allow and deny. Must not: allow by default, trust a role the caller claims, throw
 * from `can` (whatever it is given), or put another user's data in a reason a client sees.
 */
import { AppError, unavailable } from '../errors/index.js';
import type { Logger } from '../log/logger.js';
import { noopMetrics, type Metrics } from '../log/metrics.js';
import {
  isAction,
  isSessionRole,
  isWorkspaceRole,
  type Action,
  type SessionRole,
  type WorkspaceRole,
} from './actions.js';
import {
  MATRIX,
  ORDINARY_ROLES,
  type Condition,
  type SessionRule,
  type WorkspaceRule,
} from './matrix.js';
import type { MembershipReader } from './membership.js';
import { hasScope } from './scopes.js';

/** Who acts: a signed-in user, or an API key of one workspace (CT-AUTH). */
export type Actor =
  | { kind: 'user'; userId: string; scopes: readonly string[] }
  | { kind: 'api_key'; keyId: string; workspaceId: string; scopes: readonly string[] };

/** What is acted on. Ids are server-side facts; flags come from server-side state too. */
export interface Resource {
  workspaceId?: string;
  sessionId?: string;
  /** The user the resource belongs to (an API key, a membership). */
  ownerUserId?: string;
  /** The current workspace role of the member acted on (role change, removal). */
  targetRole?: WorkspaceRole;
  /** The role a role change would give. */
  newRole?: WorkspaceRole;
  /** A guest was invited to this session. */
  invited?: boolean;
  /** The session's mode (CT-WS-SESSION-EVENTS). */
  sessionMode?: 'command_post' | 'branch';
}

/** The actor's roles, as membership state says (never as the actor claims). */
export interface CanContext {
  workspaceRole?: WorkspaceRole;
  sessionRole?: SessionRole;
  /** The actor is a delegated approver of the session (CT-WS-CONTROL `control.policy`). */
  delegatedApprover?: boolean;
}

/** Why something was denied; for logs and audit, never for clients. */
export type DenyReason =
  | 'unknown_action'
  | 'unknown_actor'
  | 'not_a_member'
  | 'role'
  | 'condition'
  | 'api_key'
  | 'scope'
  | 'other_workspace'
  | 'error';

/** An answer: allowed (for guests' reads, `limited`), or denied with a reason. */
export type Decision = { allow: true; limited?: true } | { allow: false; reason: DenyReason };

const ALLOW: Decision = Object.freeze({ allow: true });
const LIMITED: Decision = Object.freeze({ allow: true, limited: true });
const deny = (reason: DenyReason): Decision => ({ allow: false, reason });

const isOrdinary = (role: unknown): boolean =>
  isWorkspaceRole(role) && ORDINARY_ROLES.includes(role);

function meets(condition: Condition, userId: string, resource: Resource): boolean {
  switch (condition) {
    case 'always':
    case 'limited':
      return true;
    case 'if_invited':
      return resource.invited === true;
    case 'own_keys':
      return typeof resource.ownerUserId === 'string' && resource.ownerUserId === userId;
    case 'owner_assigns':
      return (
        isWorkspaceRole(resource.targetRole) &&
        resource.targetRole !== 'owner' &&
        isWorkspaceRole(resource.newRole) &&
        resource.newRole !== 'owner'
      );
    case 'admin_assigns':
      return isOrdinary(resource.targetRole) && isOrdinary(resource.newRole);
    case 'owner_removes':
      return isWorkspaceRole(resource.targetRole) && resource.targetRole !== 'owner';
    case 'admin_removes':
      return isOrdinary(resource.targetRole);
    case 'branch_mode':
      return resource.sessionMode === 'branch';
    default:
      return false;
  }
}

function decideWorkspace(
  rule: WorkspaceRule,
  userId: string,
  resource: Resource,
  ctx: CanContext,
): Decision {
  const role = ctx.workspaceRole;
  if (!isWorkspaceRole(role)) return deny('not_a_member');
  // Leaving: a member may remove their own membership, unless they own the workspace.
  if (
    rule.self === true &&
    resource.ownerUserId === userId &&
    isWorkspaceRole(resource.targetRole) &&
    resource.targetRole !== 'owner'
  ) {
    return ALLOW;
  }
  const condition = rule.roles[role];
  if (condition === undefined) return deny('role');
  if (!meets(condition, userId, resource)) return deny('condition');
  return condition === 'limited' ? LIMITED : ALLOW;
}

function decideSession(
  rule: SessionRule,
  userId: string,
  resource: Resource,
  ctx: CanContext,
): Decision {
  const role = ctx.sessionRole;
  if (!isSessionRole(role)) return deny('not_a_member');
  const condition = rule.roles[role];
  if (condition !== undefined && meets(condition, userId, resource)) return ALLOW;
  if (rule.delegates === true && ctx.delegatedApprover === true) return ALLOW;
  return deny(condition === undefined ? 'role' : 'condition');
}

/**
 * Whether `actor` may do `action` to `resource`, given the roles membership state gives it.
 * Denies by default: an unknown action, actor or role, a missing role, an API key on anything
 * session-related or outside its workspace. Never throws.
 */
export function can(
  actor: Actor,
  action: Action,
  resource: Resource,
  ctx: CanContext = {},
): Decision {
  try {
    if (!isAction(action)) return deny('unknown_action');
    const rule = MATRIX[action];
    const res: Resource = typeof resource === 'object' && resource !== null ? resource : {};
    const context: CanContext = typeof ctx === 'object' && ctx !== null ? ctx : {};
    if (actor?.kind === 'api_key') {
      // CT-AUTH: keys are not members: no session actions, and only their own workspace.
      if (rule.kind === 'session' || rule.apiKeyScope === undefined) return deny('api_key');
      if (typeof actor.workspaceId !== 'string' || actor.workspaceId !== res.workspaceId)
        return deny('other_workspace');
      return hasScope(actor, rule.apiKeyScope) ? ALLOW : deny('scope');
    }
    if (actor?.kind !== 'user' || typeof actor.userId !== 'string' || actor.userId === '')
      return deny('unknown_actor');
    return rule.kind === 'workspace'
      ? decideWorkspace(rule, actor.userId, res, context)
      : decideSession(rule, actor.userId, res, context);
  } catch {
    return deny('error');
  }
}

/** The audit event of a denied privileged action (CT-RBAC rule 6). */
export interface RbacDeniedEvent {
  action: 'rbac.denied';
  actor: { kind: 'user'; id: string } | { kind: 'api_key'; id: string; workspaceId: string };
  /** The action that was refused. */
  attempted: Action;
  /** Ids only. */
  resource: { workspaceId?: string; sessionId?: string; ownerUserId?: string };
  reason: DenyReason;
  /** ISO 8601. */
  at: string;
}

/** Where denials are recorded (B036's audit emitter). */
export interface AuditSink {
  record(event: RbacDeniedEvent): Promise<void>;
}

/** What `authorize` needs. */
export interface AuthorizerDeps {
  memberships: MembershipReader;
  audit: AuditSink;
  logger?: Logger;
  metrics?: Metrics;
  /** Epoch ms, for the audit time; default Date.now. */
  now?: () => number;
}

/** Extra server-side facts for one decision. */
export interface AuthorizeOptions {
  delegatedApprover?: boolean;
}

/** Loads roles, decides, audits and throws. */
export interface Authorizer {
  /** The decision, with roles loaded from membership state (503 when they cannot be read). */
  decide(
    actor: Actor,
    action: Action,
    resource: Resource,
    opts?: AuthorizeOptions,
  ): Promise<Decision>;
  /** Resolves when allowed; otherwise audits a privileged denial and throws 403 `forbidden`. */
  authorize(
    actor: Actor,
    action: Action,
    resource: Resource,
    opts?: AuthorizeOptions,
  ): Promise<void>;
}

/** The detail every denial gets: nothing about who or why. */
export const FORBIDDEN_DETAIL = 'You do not have permission to do this.';

/** An authorizer over a membership reader and an audit sink. */
export function createAuthorizer(deps: AuthorizerDeps): Authorizer {
  const metrics = deps.metrics ?? noopMetrics;
  const now = deps.now ?? Date.now;

  const decide = async (
    actor: Actor,
    action: Action,
    resource: Resource,
    opts: AuthorizeOptions = {},
  ): Promise<Decision> => {
    const ctx: CanContext = {
      ...(opts.delegatedApprover === true ? { delegatedApprover: true } : {}),
    };
    if (actor?.kind === 'user' && typeof actor.userId === 'string') {
      try {
        if (typeof resource?.workspaceId === 'string') {
          const role = await deps.memberships.workspaceRole(actor.userId, resource.workspaceId);
          if (role !== null) ctx.workspaceRole = role;
        }
        if (typeof resource?.sessionId === 'string') {
          const role = await deps.memberships.sessionRole(actor.userId, resource.sessionId);
          if (role !== null) ctx.sessionRole = role;
        }
      } catch (err) {
        // Never allow on doubt: no roles, no decision.
        throw unavailable(undefined, 'Permissions cannot be checked right now.', { cause: err });
      }
    }
    return can(actor, action, resource, ctx);
  };

  return {
    decide,
    async authorize(actor, action, resource, opts = {}) {
      const decision = await decide(actor, action, resource, opts);
      if (decision.allow) return;
      metrics.counter('rbac_denied_total', { action: isAction(action) ? action : 'unknown' }).inc();
      if (isAction(action) && MATRIX[action].privileged) {
        const event: RbacDeniedEvent = {
          action: 'rbac.denied',
          actor:
            actor?.kind === 'api_key'
              ? { kind: 'api_key', id: actor.keyId, workspaceId: actor.workspaceId }
              : { kind: 'user', id: actor?.kind === 'user' ? actor.userId : 'unknown' },
          attempted: action,
          resource: {
            ...(resource?.workspaceId === undefined ? {} : { workspaceId: resource.workspaceId }),
            ...(resource?.sessionId === undefined ? {} : { sessionId: resource.sessionId }),
            ...(resource?.ownerUserId === undefined ? {} : { ownerUserId: resource.ownerUserId }),
          },
          reason: decision.reason,
          at: new Date(now()).toISOString(),
        };
        try {
          await deps.audit.record(event);
        } catch (err) {
          // The denial stands; the lost record is counted and logged.
          metrics.counter('rbac_audit_failures_total').inc();
          deps.logger?.error(
            { err, attempted: action, reason: decision.reason },
            'rbac.audit_failed',
          );
        }
      }
      throw new AppError('forbidden', { detail: FORBIDDEN_DETAIL });
    },
  };
}
