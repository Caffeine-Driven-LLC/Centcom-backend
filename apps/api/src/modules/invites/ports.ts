/**
 * What invites need from other lanes (B029):
 *
 * - `SeatGate` (B030, the Fastify decorator `seatGate`): refuses a new member when the workspace
 *   has no free seat, by throwing a 403 of the `entitlement_*` family (`seat_limit_reached`). It
 *   runs inside the transaction that adds the member, after the workspace row is locked, so two
 *   accepts cannot both take the last seat. Invite routes refuse to start without it (fail closed).
 * - `InviteUrlBuilder` (B033): the links an invite token goes into.
 *
 * Owns: the two contracts. Must not: be satisfied by a gate that allows everything in production.
 */
import type { AuditDb } from '@centcom/core';

/** Seat checks (B030). */
export interface SeatGate {
  /**
   * Resolves when the workspace can take one more member; throws a 403 AppError
   * (`seat_limit_reached`, `entitlement_required`) otherwise. `trx` is the transaction that will
   * add the member: count in it.
   */
  assertCanAdd(trx: AuditDb, workspaceId: string): Promise<void>;
}

/** Invite links (B033). */
export interface InviteUrlBuilder {
  /** The web link the invite e-mail and the create response carry (`https://…/i/<token>`). */
  inviteUrl(token: string): string;
  /** The app link that opens the invite in a client. */
  joinUrl(token: string): string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** B030's seat checks; invite routes refuse to start without it. */
    seatGate: SeatGate;
  }
}
