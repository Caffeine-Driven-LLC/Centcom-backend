/**
 * The CT-RBAC permission matrix as data (B021): one rule per catalogue action, each citing the
 * contract row it encodes (`row` is the row's label in contracts/01-auth-rbac.md, and the matrix
 * test reads the tables from there to check every cell). A role missing from a rule is denied; a
 * role present is allowed under its condition.
 *
 * Owns: who may do what. Must not: allow anything without a contract row behind it.
 */
import type {
  Action,
  SessionAction,
  SessionRole,
  WorkspaceAction,
  WorkspaceRole,
} from './actions.js';
import type { Scope } from './scopes.js';

/**
 * When a role's ✓ applies:
 * - `always`;
 * - `limited`: allowed, with the reduced view CT-RBAC gives guests;
 * - `if_invited`: a guest invited to the session (`resource.invited`);
 * - `own_keys`: only the actor's own API keys (`resource.ownerUserId`);
 * - `owner_assigns`: any role but a second owner, to anyone but the owner (use transfer);
 * - `admin_assigns`: from and to `member`, `billing` or `guest` only;
 * - `owner_removes`: anyone but the owner;
 * - `admin_removes`: `member`, `billing` or `guest` only;
 * - `branch_mode`: in a branch-mode session (`resource.sessionMode`).
 */
export type Condition =
  | 'always'
  | 'limited'
  | 'if_invited'
  | 'own_keys'
  | 'owner_assigns'
  | 'admin_assigns'
  | 'owner_removes'
  | 'admin_removes'
  | 'branch_mode';

/** A rule decided by the workspace role. */
export interface WorkspaceRule {
  kind: 'workspace';
  /** The CT-RBAC row (workspace table). */
  row: string;
  roles: Partial<Record<WorkspaceRole, Condition>>;
  /** A denial is audited (CT-RBAC rule 6); reads are not privileged. */
  privileged: boolean;
  /** The scope an API key needs; absent: API keys are denied. */
  apiKeyScope?: Scope;
  /** A member may do it to their own membership (leave), unless they are the owner. */
  self?: true;
}

/** A rule decided by the session role. */
export interface SessionRule {
  kind: 'session';
  /** The CT-RBAC row (session table). */
  row: string;
  roles: Partial<Record<SessionRole, Condition>>;
  privileged: boolean;
  /** Delegated approvers (CT-WS-CONTROL `control.policy`) may do it whatever their role. */
  delegates?: true;
}

/** Workspace roles that never manage other members' roles or admins. */
export const ORDINARY_ROLES: readonly WorkspaceRole[] = ['member', 'billing', 'guest'];

type Matrix = { readonly [A in WorkspaceAction]: WorkspaceRule } & {
  readonly [A in SessionAction]: SessionRule;
};

const OWNER_ADMIN = { owner: 'always', admin: 'always' } as const;

/** One rule per action. */
export const MATRIX: Matrix = {
  // Workspace table.
  'workspace.read': {
    kind: 'workspace',
    row: 'Read workspace, members',
    roles: {
      owner: 'always',
      admin: 'always',
      member: 'always',
      billing: 'always',
      guest: 'limited',
    },
    privileged: false,
    apiKeyScope: 'workspaces:read',
  },
  'workspace.update': {
    kind: 'workspace',
    row: 'Update workspace settings',
    roles: OWNER_ADMIN,
    privileged: true,
    apiKeyScope: 'workspaces:write',
  },
  'member.invite': {
    kind: 'workspace',
    row: 'Invite / remove members',
    roles: OWNER_ADMIN,
    privileged: true,
  },
  // CT-API-WORKSPACES: DELETE …/members/{mem} is "admin+ / self".
  'member.remove': {
    kind: 'workspace',
    row: 'Invite / remove members',
    roles: { owner: 'owner_removes', admin: 'admin_removes' },
    privileged: true,
    self: true,
  },
  // Resolved in v1.1.0: the owner assigns any role but a second owner; an admin assigns member,
  // billing or guest; only the owner grants or removes admin.
  'member.role.change': {
    kind: 'workspace',
    row: 'Change member role',
    roles: { owner: 'owner_assigns', admin: 'admin_assigns' },
    privileged: true,
  },
  'workspace.transfer': {
    kind: 'workspace',
    row: 'Transfer ownership',
    roles: { owner: 'always' },
    privileged: true,
  },
  'billing.read': {
    kind: 'workspace',
    row: 'View billing, invoices',
    roles: { owner: 'always', admin: 'always', billing: 'always' },
    privileged: true,
    apiKeyScope: 'billing:read',
  },
  'billing.manage': {
    kind: 'workspace',
    row: 'Change plan, payment method, seats',
    roles: { owner: 'always', billing: 'always' },
    privileged: true,
    apiKeyScope: 'billing:write',
  },
  'session.create': {
    kind: 'workspace',
    row: 'Create/host session',
    roles: { owner: 'always', admin: 'always', member: 'always' },
    privileged: true,
  },
  'session.join.editor': {
    kind: 'workspace',
    row: 'Join session (as editor)',
    roles: { owner: 'always', admin: 'always', member: 'always' },
    privileged: true,
  },
  'session.join.viewer': {
    kind: 'workspace',
    row: 'Join session (as viewer)',
    roles: { owner: 'always', admin: 'always', member: 'always', guest: 'if_invited' },
    privileged: true,
  },
  'audit.read': {
    kind: 'workspace',
    row: 'Read audit log',
    roles: OWNER_ADMIN,
    privileged: true,
    apiKeyScope: 'audit:read',
  },
  'webhook.manage': {
    kind: 'workspace',
    row: 'Manage webhooks, API keys',
    roles: OWNER_ADMIN,
    privileged: true,
    apiKeyScope: 'webhooks:write',
  },
  'apikey.manage.any': {
    kind: 'workspace',
    row: 'Manage webhooks, API keys',
    roles: OWNER_ADMIN,
    privileged: true,
  },
  'apikey.manage.own': {
    kind: 'workspace',
    row: 'Manage webhooks, API keys',
    roles: { owner: 'always', admin: 'always', member: 'own_keys' },
    privileged: true,
  },
  'workspace.delete': {
    kind: 'workspace',
    row: 'Delete workspace',
    roles: { owner: 'always' },
    privileged: true,
  },

  // Session table.
  'session.message.send': {
    kind: 'session',
    row: 'Send frames of type `message.user`, submit queue item',
    roles: { host: 'always', editor: 'always' },
    privileged: true,
  },
  'session.queue.submit': {
    kind: 'session',
    row: 'Send frames of type `message.user`, submit queue item',
    roles: { host: 'always', editor: 'always' },
    privileged: true,
  },
  'session.queue.decide': {
    kind: 'session',
    row: 'Approve / reject / reorder / drop queue items',
    roles: { host: 'always' },
    privileged: true,
  },
  'session.tool.approve': {
    kind: 'session',
    row: 'Approve tool calls',
    roles: { host: 'always' },
    privileged: true,
    delegates: true,
  },
  'session.agent.run': {
    kind: 'session',
    row: "Run agents (host's runner)",
    roles: { host: 'always' },
    privileged: true,
  },
  'session.agent.spawn_branch': {
    kind: 'session',
    row: 'Spawn own branch agent (branch mode)',
    roles: { host: 'branch_mode', editor: 'branch_mode' },
    privileged: true,
  },
  // One row, three actions: viewers may react and comment, not send presence or cursors.
  'session.presence': {
    kind: 'session',
    row: 'Presence, cursors, reactions, comments',
    roles: { host: 'always', editor: 'always' },
    privileged: false,
  },
  'session.react': {
    kind: 'session',
    row: 'Presence, cursors, reactions, comments',
    roles: { host: 'always', editor: 'always', viewer: 'always' },
    privileged: false,
  },
  'session.comment': {
    kind: 'session',
    row: 'Presence, cursors, reactions, comments',
    roles: { host: 'always', editor: 'always', viewer: 'always' },
    privileged: false,
  },
  'session.control': {
    kind: 'session',
    row: 'Kick, mute, change roles, end session, transfer host',
    roles: { host: 'always' },
    privileged: true,
  },
  'session.history.read': {
    kind: 'session',
    row: 'Read history',
    roles: { host: 'always', editor: 'always', viewer: 'always' },
    privileged: false,
  },
};

/** The rule of an action. */
export const ruleOf = (action: Action): WorkspaceRule | SessionRule => MATRIX[action];
