/**
 * Member slots (B031, CT-WS-SESSION-EVENTS "Member slots and colours"): the relay's slot service.
 * A member's slot is assigned at their first join in a session: the lowest free one, which is
 * one past the highest, since slots are never reused. It stays theirs for the session's life (a
 * member who leaves and comes back, or connects from a second device, keeps it), and no one else
 * ever gets it. 50 members at most.
 *
 * Assignment is atomic in the database (`@centcom/db` `createSessionSlotStore`: the session row is
 * locked for it), so relay nodes never collide; a unique violation all the same is retried up to
 * 3 times, then answered with a retryable 503. Nothing is cached in memory: a slot is returned only
 * once it is committed.
 *
 * Owns: slot rules and their errors. Must not: hand out colours or anything but ids and integers.
 */
import { isId } from '@centcom/contracts';
import { AppError, unavailable } from '@centcom/core';
import { isConnectionError, type SessionSlotStore } from '@centcom/db';

/** CT-WS-SESSION-EVENTS: the hard cap of members per session, so slots 0-49. */
export const MAX_SESSION_MEMBERS = 50;
/** Tries of an assignment that hit a unique violation. */
export const SLOT_ASSIGN_ATTEMPTS = 3;

/** SQLSTATE unique_violation and query_canceled (the 2 s statement timeout). */
const UNIQUE_VIOLATION = '23505';
const QUERY_CANCELED = '57014';
const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/** 50 members already hold slots in the session: `session_full` (403). */
export class SlotsExhaustedError extends AppError {
  constructor() {
    super('session_full', { detail: 'The session already has the most members it can hold.' });
  }
}
Object.defineProperty(SlotsExhaustedError.prototype, 'name', {
  value: 'SlotsExhaustedError',
  writable: true,
  configurable: true,
});

/** There is no such session: `session_not_found` (404); the relay closes with 4404. */
export class SessionNotFoundError extends AppError {
  constructor() {
    super('session_not_found', { detail: 'There is no such session.' });
  }
}
Object.defineProperty(SessionNotFoundError.prototype, 'name', {
  value: 'SessionNotFoundError',
  writable: true,
  configurable: true,
});

/** Slots of a session's members. */
export interface SlotService {
  /** The member's slot, assigned on their first call. */
  assign(sessionId: string, memberId: string): Promise<number>;
  /** The member's slot, or null when they have none. */
  get(sessionId: string, memberId: string): Promise<number | null>;
  /** Every slot of the session, lowest first, for the roster. */
  list(sessionId: string): Promise<{ memberId: string; slot: number }[]>;
  /** Deletes the session's slots (the retention job); other sessions are untouched. */
  deleteForSession(sessionId: string): Promise<void>;
}

/** A database failure as the caller sees it: a lost connection or a timeout is a retryable 503. */
function asUnavailable(err: unknown): unknown {
  if (isConnectionError(err) || codeOf(err) === QUERY_CANCELED) {
    return unavailable(1, undefined, { cause: new Error('slot store unavailable') });
  }
  return err;
}

/** The slot service over `store`. */
export function createSlotService(store: SessionSlotStore): SlotService {
  return {
    async assign(sessionId, memberId) {
      if (!isId('ses', sessionId)) throw new SessionNotFoundError();
      if (!isId('mem', memberId)) throw new TypeError('assign: memberId must be a mem_ id');
      for (let attempt = 1; ; attempt++) {
        let outcome;
        try {
          outcome = await store.assign(sessionId, memberId, MAX_SESSION_MEMBERS);
        } catch (err) {
          if (codeOf(err) !== UNIQUE_VIOLATION) throw asUnavailable(err);
          if (attempt >= SLOT_ASSIGN_ATTEMPTS) {
            throw unavailable(1, undefined, { cause: new Error('slot assignment kept colliding') });
          }
          continue;
        }
        if (outcome.kind === 'no_session') throw new SessionNotFoundError();
        if (outcome.kind === 'full') throw new SlotsExhaustedError();
        return outcome.slot;
      }
    },

    async get(sessionId, memberId) {
      try {
        return await store.get(sessionId, memberId);
      } catch (err) {
        throw asUnavailable(err);
      }
    },

    async list(sessionId) {
      try {
        return await store.list(sessionId);
      } catch (err) {
        throw asUnavailable(err);
      }
    },

    async deleteForSession(sessionId) {
      try {
        await store.deleteForSession(sessionId);
      } catch (err) {
        throw asUnavailable(err);
      }
    },
  };
}
