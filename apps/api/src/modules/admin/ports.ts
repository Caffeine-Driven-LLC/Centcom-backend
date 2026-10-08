/**
 * What the admin API calls in other lanes (B087), as narrow interfaces so tests use fakes:
 *
 * - `AdminTokens` (B017's TokenService): authentication, and revoking a user's or a device's tokens.
 * - `AdminEntitlements` (B069's EntitlementService.get): plan, subscription status, limits, usage.
 * - `FlagAdminPort` (B083's FlagAdmin) and `StatusAdminPort` (B086's StatusAdmin).
 * - `InviteResender` and `PromotionGranter`: B029 has no resend yet and B079 is not built. Until
 *   they are wired, their routes answer 503 (and are audited like every other call).
 *
 * A port's 4xx AppError reaches the caller as it is; anything else it throws is a 502.
 *
 * Owns: these contracts. Must not: widen them beyond what the admin routes call.
 */
import type { Api } from '@centcom/contracts';
import type { Actor } from '@centcom/core';
import type { Principal } from '../auth/tokens/service.js';
import type { Incident } from '../status/service.js';
import type { IncidentStatus } from '@centcom/db';

/** Who acts, in a port call: a staff member's `usr_` id. */
export interface StaffActor {
  type: 'staff';
  id: string;
}

/** B017's token service, as the admin API uses it. */
export interface AdminTokens {
  /** The principal behind a bearer credential; a 401 AppError for a bad one. */
  authenticate(credential: string): Promise<Principal>;
  /** Revokes every refresh and access token of the user; resolves to the refresh tokens revoked. */
  revokeUser(userId: string): Promise<number>;
  /** Revokes a device, its refresh tokens and its access tokens. */
  revokeDevice(deviceId: string): Promise<void>;
}

/** B069's entitlements. */
export interface AdminEntitlements {
  /** The workspace's entitlements; null when it has none. */
  get(workspaceId: string): Promise<Api.Entitlements | null>;
}

/** B083's flag administration. */
export interface FlagAdminPort {
  setFlag(input: unknown, actor: Actor): Promise<{ rev: number }>;
  deleteFlag(key: string, actor: Actor): Promise<{ rev: number }>;
}

/** B086's incident administration. */
export interface StatusAdminPort {
  createIncident(input: {
    title: string;
    component_ids: string[];
    status: IncidentStatus;
  }): Promise<Incident>;
  addIncidentUpdate(id: string, text: string, status?: IncidentStatus): Promise<Incident>;
}

/** Re-sends a pending invite (to be provided by the invites lane, B029). */
export interface InviteResender {
  /**
   * Issues the invite a new token and expiry and e-mails it again. 404 `not_found` for an unknown
   * invite; 410 for one that is no longer pending.
   */
  resend(
    inviteId: string,
    by: StaffActor,
  ): Promise<{ invite: string; workspace: string; expires_at: string }>;
}

/** Grants a promotion (B079's `grantPromotion`). */
export interface PromotionGranter {
  grantPromotion(
    workspaceId: string,
    promotionCodeId: string,
    actor: StaffActor,
  ): Promise<Api.Subscription>;
}
