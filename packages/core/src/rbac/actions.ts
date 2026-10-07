/**
 * The action catalogue (B021, CT-RBAC): every question the RBAC engine answers is one of these
 * actions. Each has exactly one rule in `matrix.ts`; a test fails when one is missing.
 *
 * Owns: the names. Must not: grow an action without a matrix rule and its contract row.
 */
import type { Api } from '@centcom/contracts';

/** Workspace roles (CT-RBAC). */
export type WorkspaceRole = Api.Role;
/** Session roles (CT-RBAC). */
export type SessionRole = Api.SessionRole;

/** Every workspace role, most powerful first. */
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = [
  'owner',
  'admin',
  'member',
  'billing',
  'guest',
];
/** Every session role, most powerful first. */
export const SESSION_ROLES: readonly SessionRole[] = ['host', 'editor', 'viewer'];

/** Actions decided by the actor's workspace role. */
export const WORKSPACE_ACTIONS = [
  'workspace.read',
  'workspace.update',
  'member.invite',
  'member.remove',
  'member.role.change',
  'workspace.transfer',
  'billing.read',
  'billing.manage',
  'session.create',
  'session.join.editor',
  'session.join.viewer',
  'audit.read',
  'webhook.manage',
  'apikey.manage.any',
  'apikey.manage.own',
  'workspace.delete',
] as const;

/** Actions decided by the actor's role in a session. */
export const SESSION_ACTIONS = [
  'session.message.send',
  'session.queue.submit',
  'session.queue.decide',
  'session.tool.approve',
  'session.agent.run',
  'session.agent.spawn_branch',
  'session.presence',
  'session.react',
  'session.comment',
  'session.control',
  'session.history.read',
] as const;

export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];
export type SessionAction = (typeof SESSION_ACTIONS)[number];
/** An RBAC action. */
export type Action = WorkspaceAction | SessionAction;

/** Every action. */
export const ACTIONS: readonly Action[] = [...WORKSPACE_ACTIONS, ...SESSION_ACTIONS];

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);
const WORKSPACE_ROLE_SET: ReadonlySet<string> = new Set(WORKSPACE_ROLES);
const SESSION_ROLE_SET: ReadonlySet<string> = new Set(SESSION_ROLES);

/** True for a catalogue action. */
export const isAction = (value: unknown): value is Action =>
  typeof value === 'string' && ACTION_SET.has(value);
/** True for a workspace role. */
export const isWorkspaceRole = (value: unknown): value is WorkspaceRole =>
  typeof value === 'string' && WORKSPACE_ROLE_SET.has(value);
/** True for a session role. */
export const isSessionRole = (value: unknown): value is SessionRole =>
  typeof value === 'string' && SESSION_ROLE_SET.has(value);

/**
 * CT-RBAC: a member's default session role: owner, admin and member edit, guests view. `billing`
 * may not join sessions at all; should one be added anyway, it gets the least privilege.
 */
export function defaultSessionRole(workspaceRole: WorkspaceRole): 'editor' | 'viewer' {
  return workspaceRole === 'owner' || workspaceRole === 'admin' || workspaceRole === 'member'
    ? 'editor'
    : 'viewer';
}
