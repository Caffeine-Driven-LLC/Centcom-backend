/**
 * Which workspace a usage event counts against (B074):
 *
 * 1. an event with `session_id`: the session's workspace, whatever the token's `wsp` claim says.
 *    The caller must take part in the session (a member on any device, or its creator); a session
 *    that does not exist or is someone else's is 403 for the whole batch, so sessions cannot be
 *    probed. A session without a live workspace falls through to 2;
 * 2. else the token's `wsp` claim, while the caller is still a member of that live workspace;
 * 3. else the caller's personal workspace (B022's rule).
 *
 * With no workspace at all, the batch is 403.
 *
 * Owns: these rules. Must not: trust the `wsp` claim without checking membership.
 */
import { AppError } from '@centcom/core';
import type { AttributionStore } from './repository.js';

/** The details of attribution's refusals (GUIDELINES §3.4). */
export const ATTRIBUTION_DETAILS = Object.freeze({
  notParticipant: 'Usage can be reported only for sessions you take part in.',
  noWorkspace: 'There is no workspace to report this usage to.',
} as const);

/** The reporting device's principal. */
export interface DevicePrincipal {
  userId: string;
  deviceId: string;
  /** The token's `wsp` claim, a hint only. */
  workspaceId?: string;
}

/** Where a batch's events go: by session, and for events without one. */
export interface Attribution {
  /** The workspace of each session the batch names. */
  bySession: ReadonlyMap<string, string>;
  /** The workspace of events without a session (or with one that has no live workspace). */
  fallback: string | null;
}

/** Attributes the sessions `sessionIds` (the distinct ones a batch names) for `principal`. */
export async function attribute(
  store: AttributionStore,
  principal: DevicePrincipal,
  sessionIds: readonly string[],
  needsFallback: boolean,
): Promise<Attribution> {
  const bySession = new Map<string, string>();
  let fallbackNeeded = needsFallback;
  for (const sessionId of new Set(sessionIds)) {
    const access = await store.sessionAccess(sessionId, principal.userId);
    if (access === null || !access.participant) {
      throw new AppError('forbidden', { detail: ATTRIBUTION_DETAILS.notParticipant });
    }
    if (access.workspaceId === null) fallbackNeeded = true;
    else bySession.set(sessionId, access.workspaceId);
  }
  let fallback: string | null = null;
  if (fallbackNeeded) {
    const claim = principal.workspaceId;
    fallback =
      claim !== undefined && (await store.isMember(principal.userId, claim))
        ? claim
        : await store.personalWorkspace(principal.userId);
    if (fallback === null)
      throw new AppError('forbidden', { detail: ATTRIBUTION_DETAILS.noWorkspace });
  }
  return { bySession, fallback };
}

/** The workspace of one event. */
export function workspaceOf(attribution: Attribution, sessionId: string | null): string {
  const workspace =
    (sessionId === null ? undefined : attribution.bySession.get(sessionId)) ?? attribution.fallback;
  if (workspace === null)
    throw new AppError('forbidden', { detail: ATTRIBUTION_DETAILS.noWorkspace });
  return workspace;
}
