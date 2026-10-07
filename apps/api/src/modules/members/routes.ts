/**
 * Members of a workspace (B028, CT-API-WORKSPACES):
 *
 * - `GET /v1/workspaces/{id}/members` (`workspaces:read`, member+): oldest first, CT-PAGE.
 *   Owners and admins see addresses; members and billing see names and roles; guests see
 *   `{id, display_name, role}` (CT-RBAC).
 * - `PATCH /v1/workspaces/{id}/members/{mem}` (`workspaces:write`): `{role}`; the owner gives any
 *   role but owner, an admin gives member, billing or guest to members who have one of those.
 * - `DELETE /v1/workspaces/{id}/members/{mem}` (`workspaces:write`): an admin+ removes, anyone
 *   but the owner leaves (204). The owner leaving is a 409: transfer first.
 * - `POST /v1/workspaces/{id}/transfer-ownership` (`workspaces:write`, owner, `Idempotency-Key`
 *   accepted): `{to_member}`, an admin; 200 with the workspace as the caller now sees it.
 *
 * Who may act is B021's RBAC, from live membership rows: a caller who is not a member gets 404;
 * a member whose role falls short gets 403, and the denial is audited. A refusal of the owner
 * rules (leaving, a transfer that cannot happen) is audited as `denied` too.
 *
 * Owns: the HTTP side of members. Must not: show an address to anyone below admin, or compare
 * roles itself.
 */
import { isId, type Api } from '@centcom/contracts';
import {
  AppError,
  defineFilters,
  idFilter,
  isAppError,
  notFound,
  parsePageQuery,
  type Action,
  type Actor,
  type Resource,
  type SigningKeys,
} from '@centcom/core';
import type { MemberRecord, WorkspaceStore } from '@centcom/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireScope } from '../../plugins/rbac.js';
import type { AuditInput } from '../../plugins/audit.js';
import { ctxOf, workspaceAccess } from '../workspaces/access.js';
import { workspaceBody } from '../workspaces/routes.js';
import { WORKSPACE_DETAILS } from '../workspaces/service.js';
import { parseRoleUpdate, parseTransfer } from './input.js';
import { MEMBER_DETAILS, type MembershipService } from './service.js';

/** Options for `memberRoutes`. */
export interface MemberRouteOptions {
  members: MembershipService;
  /** For the transfer's answer, the workspace as the caller then sees it. */
  workspaces: WorkspaceStore;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

const LIST_SPEC = { sorts: ['joined'], defaultSort: 'joined' } as const;
/** A cursor is bound to the workspace whose members it pages. */
const LIST_FILTERS = defineFilters({ workspace: idFilter('wsp') });

/** How much of a member a viewer sees. */
export type MemberView = 'full' | 'no_address' | 'limited';
type View = MemberView;

/** A member as CT-API-WORKSPACES `Member`, cut to what `view` allows. */
export function memberBody(member: MemberRecord, view: View): Api.Member | Record<string, unknown> {
  if (view === 'limited') {
    return { id: member.id, display_name: member.displayName, role: member.role };
  }
  return {
    id: member.id,
    user: member.userId,
    display_name: member.displayName,
    ...(view === 'full' ? { email: member.email } : {}),
    role: member.role,
    joined_at: member.joinedAt.toISOString(),
  };
}

/** What `actor` may see of members: addresses for owners and admins (users) only. */
async function viewOf(
  options: MemberRouteOptions,
  actor: Actor,
  workspaceId: string,
  limited: boolean,
): Promise<View> {
  if (limited) return 'limited';
  if (actor.kind !== 'user') return 'no_address';
  const me = await options.members.getLive(workspaceId, actor.userId);
  return me?.role === 'owner' || me?.role === 'admin' ? 'full' : 'no_address';
}

/** The `:mem` member of the workspace, or 404. */
async function targetOf(
  options: MemberRouteOptions,
  request: FastifyRequest,
  workspaceId: string,
): Promise<MemberRecord> {
  const memberId = (request.params as Record<string, unknown>)['mem'];
  const target = isId('mem', memberId) ? await options.members.get(workspaceId, memberId) : null;
  if (target === null) throw notFound(MEMBER_DETAILS.notFound);
  return target;
}

/** Asks RBAC about `action` on the member: 403 (audited by the authorizer) when refused. */
function authorize(
  request: FastifyRequest,
  actor: Actor,
  action: Action,
  resource: Resource,
): Promise<void> {
  return request.server.rbac.authorizer.authorize(actor, action, resource);
}

/** Runs `change`; a 409 or 422 from the owner rules is audited as a denied `input` first. */
async function auditRefusal<T>(
  request: FastifyRequest,
  input: AuditInput,
  change: () => Promise<T>,
): Promise<T> {
  try {
    return await change();
  } catch (err) {
    if (isAppError(err) && (err.status === 409 || err.status === 422)) {
      request.audit.detached({ ...input, outcome: 'denied' });
    }
    throw err;
  }
}

export const memberRoutes: FastifyPluginAsync<MemberRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;
  const { members } = opts;

  app.get(
    '/v1/workspaces/:id/members',
    { preHandler: requireScope('workspaces:read') },
    async (request, reply) => {
      const { actor, workspaceId, limited } = await workspaceAccess(request, 'workspace.read');
      const query = parsePageQuery(request.query, LIST_SPEC);
      const view = await viewOf(opts, actor, workspaceId, limited);
      const page = await members.list(workspaceId, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        sort: query.sort,
        filterHash: LIST_FILTERS.hash({ workspace: workspaceId }),
        keys: opts.cursorKeys,
        now: clock(),
      });
      reply.header('cache-control', 'private, no-cache');
      return { ...page, data: page.data.map((member) => memberBody(member, view)) };
    },
  );

  app.patch(
    '/v1/workspaces/:id/members/:mem',
    { preHandler: requireScope('workspaces:write') },
    async (request) => {
      const { actor, workspaceId } = await workspaceAccess(request, 'workspace.read');
      const role = parseRoleUpdate(request.body);
      const target = await targetOf(opts, request, workspaceId);
      await authorize(request, actor, 'member.role.change', {
        workspaceId,
        targetRole: target.role,
        newRole: role,
        ownerUserId: target.userId,
      });
      const updated = await members.changeRole(
        workspaceId,
        target.id,
        role,
        target.role,
        ctxOf(request),
      );
      return memberBody(updated, 'full');
    },
  );

  app.delete(
    '/v1/workspaces/:id/members/:mem',
    { preHandler: requireScope('workspaces:write') },
    async (request, reply) => {
      const { actor, workspaceId } = await workspaceAccess(request, 'workspace.read');
      const target = await targetOf(opts, request, workspaceId);
      const self = actor.kind === 'user' && actor.userId === target.userId;
      const input: AuditInput = {
        action: 'member.remove',
        target: { type: 'membership', id: target.id },
        meta: { user_id: target.userId, role: target.role, self },
      };
      if (self && target.role === 'owner') {
        // RBAC would refuse with 403; the owner leaving is a state problem: transfer first.
        request.audit.detached({ ...input, outcome: 'denied' });
        throw new AppError('conflict', { detail: MEMBER_DETAILS.ownerStays });
      }
      await authorize(request, actor, 'member.remove', {
        workspaceId,
        targetRole: target.role,
        ownerUserId: target.userId,
      });
      await auditRefusal(request, input, () =>
        members.remove(workspaceId, target.id, target.role, self, ctxOf(request)),
      );
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/workspaces/:id/transfer-ownership',
    { preHandler: requireScope('workspaces:write'), config: { idempotency: 'accepted' } },
    async (request) => {
      const { actor, workspaceId } = await workspaceAccess(request, 'workspace.read');
      const toMember = parseTransfer(request.body);
      await authorize(request, actor, 'workspace.transfer', { workspaceId });
      // Only an owner gets past RBAC, and owners are users.
      const ownerId = actor.kind === 'user' ? actor.userId : '';
      await auditRefusal(
        request,
        {
          action: 'member.role_change',
          target: { type: 'membership', id: toMember },
          meta: { to_role: 'owner' },
        },
        () => members.transferOwnership(workspaceId, toMember, ownerId, ctxOf(request)),
      );
      const view = await opts.workspaces.findForMember(workspaceId, ownerId);
      if (view === null) throw notFound(WORKSPACE_DETAILS.notFound);
      return workspaceBody(view, false);
    },
  );
};
