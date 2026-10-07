/**
 * Member request bodies (B028, CT-API-WORKSPACES `MemberUpdate`, `OwnershipTransfer`): a role
 * change names `admin`, `member`, `billing` or `guest` (`owner` passes only by transfer); a
 * transfer names the `mem_` id of the member who becomes owner. A bad body is a 422 whose
 * `errors[]` point at the field; unknown fields are ignored (CT-VER).
 *
 * Owns: parsing the bodies. Must not: echo a rejected value.
 */
import { isId } from '@centcom/contracts';
import { validationFailed, type WorkspaceRole } from '@centcom/core';

/** The detail of a 422 on a member body (GUIDELINES §3.4). */
export const INVALID_MEMBER_BODY_DETAIL = 'Some fields are not valid.';

/** A role a PATCH may give: any but `owner`. */
export type AssignableRole = Exclude<WorkspaceRole, 'owner'>;

/** Roles a PATCH may give. */
export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ['admin', 'member', 'billing', 'guest'];

const objectBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  return body as Record<string, unknown>;
};

/** The role of a `MemberUpdate` body; `owner` and anything else not assignable are a 422. */
export function parseRoleUpdate(body: unknown): AssignableRole {
  const role = objectBody(body)['role'];
  if (role === undefined) {
    throw validationFailed(
      [{ pointer: '/role', code: 'required', detail: 'is required' }],
      INVALID_MEMBER_BODY_DETAIL,
    );
  }
  if (role === 'owner') {
    throw validationFailed(
      [
        {
          pointer: '/role',
          code: 'not_allowed',
          detail: 'owner is only given by transferring ownership',
        },
      ],
      INVALID_MEMBER_BODY_DETAIL,
    );
  }
  if (typeof role !== 'string' || !(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    throw validationFailed(
      [
        {
          pointer: '/role',
          code: 'invalid_value',
          detail: `must be one of: ${ASSIGNABLE_ROLES.join(', ')}`,
        },
      ],
      INVALID_MEMBER_BODY_DETAIL,
    );
  }
  return role as AssignableRole;
}

/** The `to_member` of an `OwnershipTransfer` body (a `mem_` id). */
export function parseTransfer(body: unknown): string {
  const to = objectBody(body)['to_member'];
  if (!isId('mem', to)) {
    throw validationFailed(
      [
        to === undefined
          ? { pointer: '/to_member', code: 'required', detail: 'is required' }
          : { pointer: '/to_member', code: 'invalid_format', detail: 'must be a mem_ id' },
      ],
      INVALID_MEMBER_BODY_DETAIL,
    );
  }
  return to;
}
