/**
 * Request and response bodies of the internal admin API (B087), for the admin console (B088) and
 * metadata search (B089). Every body is metadata: no content, history, key material, tokens,
 * secrets or payment data. E-mail addresses are masked (`a***@d***.com`) for `support_ro`.
 */
import type { Api } from '@centcom/contracts';
import type { IncidentStatus } from '@centcom/db';

/** A staff role, least to most. */
export type StaffRole = 'support_ro' | 'support_rw' | 'superadmin';

/** The staff roles, least to most. */
export const STAFF_ROLES: readonly StaffRole[] = Object.freeze([
  'support_ro',
  'support_rw',
  'superadmin',
]);

/** A device, without its keys. */
export interface AdminDevice {
  id: string;
  name: string;
  platform: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** One of a user's workspace memberships. */
export interface AdminMembership {
  member: string;
  workspace: string;
  role: Api.Role;
  joined_at: string;
}

/** `GET /users/{id}`. */
export interface AdminUser {
  id: string;
  /** Masked for `support_ro`. */
  email: string;
  display_name: string;
  status: 'active' | 'pending_deletion' | 'deleted';
  created_at: string;
  deletion_requested_at: string | null;
  login_disabled_at: string | null;
  /** The user's staff role, when they are active staff. */
  staff_role: StaffRole | null;
  devices: AdminDevice[];
  memberships: AdminMembership[];
}

/** A user in a lookup result. */
export interface AdminUserSummary {
  id: string;
  /** Masked for `support_ro`. */
  email: string;
  display_name: string;
  status: AdminUser['status'];
  created_at: string;
}

/** `GET /users?email=`: the user with that address, if any. */
export interface AdminUserLookup {
  data: AdminUserSummary[];
}

/** A member in a workspace view. */
export interface AdminWorkspaceMember {
  member: string;
  user: string;
  /** Masked for `support_ro`. */
  email: string;
  display_name: string;
  role: Api.Role;
  joined_at: string;
}

/** `GET /workspaces/{id}`. */
export interface AdminWorkspace {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  deleted_at: string | null;
  member_count: number;
  /** At most 200, oldest first; `members_truncated` says when there are more. */
  members: AdminWorkspaceMember[];
  members_truncated: boolean;
  /** Null when billing has no entitlements for the workspace. */
  plan: Api.Entitlements['plan'] | null;
  subscription_status: Api.Entitlements['status'] | null;
  entitlements: {
    rev: number;
    limits: Api.Entitlements['limits'];
    period: { start: string; end: string } | null;
    grace_until: string | null;
  } | null;
  /** Usage totals of the current period. */
  usage: NonNullable<Api.Entitlements['usage']> | null;
}

/** `GET /sessions/{id}` and `POST /sessions/{id}/end`: metadata only, never content. */
export interface AdminSession {
  id: string;
  workspace: string | null;
  state: Api.Session['state'];
  region: string;
  created_at: string;
  ended_at: string | null;
  /** Members who have not left. */
  member_count: number;
  /** The `mem_` id of the current host, if any. */
  host_member: string | null;
}

/** `POST /users/{id}/revoke-tokens` body: one device, or (without it) everything. */
export interface RevokeTokensRequest {
  device?: string;
}

/** `POST /users/{id}/revoke-tokens`. */
export interface RevokeTokensResult {
  user: string;
  /** The device revoked; null when every token of the user was. */
  device: string | null;
  /** Refresh tokens revoked (null for a device: B017 does not count them). */
  revoked_count: number | null;
}

/** `POST /users/{id}/disable`. */
export interface DisableUserResult {
  user: string;
  login_disabled_at: string;
  /** Refresh tokens revoked. */
  revoked_count: number;
}

/** `POST /invites/{id}/resend`. */
export interface InviteResendResult {
  invite: string;
  workspace: string;
  expires_at: string;
}

/** `POST /workspaces/{id}/promotions` body. */
export interface PromotionRequest {
  /** The Stripe promotion code's id (B079 validates it). */
  promotion_code_id: string;
}

/** `POST /workspaces/{id}/promotions`. */
export interface PromotionResult {
  workspace: string;
  subscription: Api.Subscription;
}

/** `PUT /flags/{key}` body: a B083 flag definition (`key`, when given, must match the path). */
export type FlagPutRequest = Record<string, unknown>;

/** `PUT /flags/{key}` and `DELETE /flags/{key}`. */
export interface FlagChangeResult {
  key: string;
  rev: number;
}

/** `POST /incidents` body. */
export interface IncidentCreateRequest {
  title: string;
  component_ids: string[];
  status: IncidentStatus;
}

/** `POST /incidents/{id}/updates` body. */
export interface IncidentUpdateRequest {
  text: string;
  status?: IncidentStatus;
}

/** `PUT /staff/{userId}` body (superadmin only, never about oneself). */
export interface StaffPutRequest {
  role: StaffRole;
}

/** A staff record. */
export interface AdminStaff {
  user: string;
  role: StaffRole;
  added_by: string | null;
  added_at: string;
  disabled_at: string | null;
}

/** One entry of `GET /staff-audit`. */
export interface StaffAuditEntry {
  id: string;
  at: string;
  actor: { type: 'staff' | 'user' | 'system'; id: string };
  outcome: 'success' | 'denied' | 'failed';
  method: string;
  route: string;
  status: number;
  /** The error code of a refused or failed call. */
  code: string | null;
  target: { type: string; id: string } | null;
  flag: string | null;
  reason: string | null;
  ticket: string | null;
}

/** `GET /staff-audit` (CT-PAGE). */
export interface StaffAuditPage {
  data: StaffAuditEntry[];
  next_cursor: string | null;
  has_more: boolean;
}
