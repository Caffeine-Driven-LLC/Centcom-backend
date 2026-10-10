/**
 * Who may send which frame kind (B043): the relay's per-kind minimum role, from the
 * CT-WS-SESSION-EVENTS catalogue's "Who may send" column and the CT-RBAC session matrix.
 *
 * - `KIND_MIN_ROLE` lists the session roles allowed to send each kind; an empty list is a
 *   server-only kind (`control.member_joined`, `control.roster`, `queue.state`, ...), refused for
 *   every client, the host included.
 * - Where the two documents differ the stricter one wins: CT-RBAC lets a viewer send reactions and
 *   comments but not cursors, so `presence.cursor` is host and editor only; `presence.update` stays
 *   open to viewers (the catalogue's "any member", and CT-RBAC's share-link guests may send it).
 * - `editor*` kinds ("in command-post mode only the host emits") are host and editor here: the
 *   relay cannot see which agent a frame is for, so content-level rules stay with the clients and
 *   the later lanes (approval delegation B060, queue rules B052, the submitter of `queue.cancel`).
 * - A kind the relay does not know (a newer client's) is forwarded for host and editor only
 *   (CT-WS-SESSION-EVENTS "Unknown kinds"), never for viewers.
 * - A muted member's `event` and `queue` frames are refused (`sys.error muted`, B051), while
 *   `presence` and `control` still pass.
 *
 * Owns: the table and `authorizeFrame`. Must not: look at `p` or `ct`, or take the role from the
 * frame or the ticket: the caller passes the member's live role.
 */
import { EVENT_KINDS } from '@centcom/contracts';

/** A session role (CT-RBAC). */
export type SessionRole = 'host' | 'editor' | 'viewer';

const HOST: readonly SessionRole[] = ['host'];
const HOST_EDITOR: readonly SessionRole[] = ['host', 'editor'];
const ANYONE: readonly SessionRole[] = ['host', 'editor', 'viewer'];
const SERVER: readonly SessionRole[] = [];

/** The roles allowed to send each catalogued kind; empty for server-only kinds. */
export const KIND_MIN_ROLE: Readonly<Record<string, readonly SessionRole[]>> = Object.freeze({
  'message.user': HOST_EDITOR,
  'message.assistant.delta': HOST_EDITOR,
  'message.assistant.done': HOST_EDITOR,
  'message.system': HOST_EDITOR,
  'tool.request': HOST_EDITOR,
  'approval.request': HOST_EDITOR,
  // "host (and delegated approvers)": delegates may be editors; B060 checks the delegation.
  'approval.decision': HOST_EDITOR,
  'tool.result': HOST_EDITOR,
  'agent.spawn': HOST_EDITOR,
  'agent.state': HOST_EDITOR,
  'agent.exit': HOST_EDITOR,
  'branch.update': HOST_EDITOR,
  'file.lock': HOST_EDITOR,
  'agent.handoff': HOST_EDITOR,
  'conflict.detected': HOST_EDITOR,
  'diff.share': HOST_EDITOR,
  reaction: ANYONE,
  'comment.add': ANYONE,
  'key.grant': HOST_EDITOR,
  'queue.submit': HOST_EDITOR,
  // "the submitter": viewers cannot submit; B052 checks it is the submitter's item.
  'queue.cancel': HOST_EDITOR,
  'queue.approve': HOST,
  'queue.reject': HOST,
  'queue.reorder': HOST,
  'queue.drop': HOST,
  'queue.claim': HOST,
  'queue.done': HOST,
  'queue.state': SERVER,
  'control.kick': HOST,
  'control.mute': HOST,
  'control.unmute': HOST,
  'control.role': HOST,
  'control.transfer_host': HOST,
  'control.end': HOST,
  'control.policy': HOST,
  'control.member_joined': SERVER,
  'control.member_left': SERVER,
  'control.roster': SERVER,
  'control.host_changed': SERVER,
  'control.session_state': SERVER,
  'control.rotate_request': HOST,
  'control.rotate_key': SERVER,
  'presence.update': ANYONE,
  'presence.nudge': HOST_EDITOR,
  // CT-RBAC: viewers send reactions and comments only, not cursors.
  'presence.cursor': HOST_EDITOR,
});

/** Kinds no client may send. */
export const SERVER_ONLY_KINDS: ReadonlySet<string> = new Set(
  Object.entries(KIND_MIN_ROLE)
    .filter(([, roles]) => roles.length === 0)
    .map(([kind]) => kind),
);

/** Roles that may send a kind the relay does not know (a newer client's). */
export const UNKNOWN_KIND_ROLES: readonly SessionRole[] = HOST_EDITOR;

/** The frame types a member sends and this stage authorises (`sys.*` and `ack` are not). */
export const MEMBER_FRAME_TYPES: ReadonlySet<string> = new Set([
  'event',
  'queue',
  'control',
  'presence',
]);

/** Frame types a mute silences. */
export const MUTED_FRAME_TYPES: ReadonlySet<string> = new Set(['event', 'queue']);

/** The member as authorisation needs it: their session and live role. */
export interface MemberRole {
  /** The session member's `mem_` id. */
  id: string;
  /** The session's `ses_` id. */
  sid: string;
  role: SessionRole;
}

/** Whether a member is muted in a session (B051 keeps the state; this lane reads it). */
export interface MuteState {
  isMuted(sid: string, memberId: string): boolean;
  /**
   * Undefined when `isMuted` can answer for `sid` now; else a promise that resolves once it can
   * (B051 reads the session's mutes) or rejects when it cannot (the frame is refused, 503).
   */
  ready?(sid: string): Promise<void> | undefined;
}

/** What authorisation needs of a frame. */
export interface FrameKind {
  t: string;
  k?: string;
}

/** The outcome: pass, refuse (`sys.error forbidden`), or refuse a muted member (`sys.error muted`). */
export type FrameDecision = { ok: true } | { ok: false; error: 'forbidden' | 'muted' };

/** True for a kind in the catalogue (the generated `EVENT_KINDS`). */
const CATALOGUED: ReadonlySet<string> = new Set(EVENT_KINDS);

/**
 * Whether member `m` (with their live role) may send `frame`. Server-only kinds
 * are forbidden for everyone; unknown kinds pass for host and editor; a frame without a kind is
 * forbidden (default deny). A muted member's `event` and `queue` frames are `muted`.
 */
export function authorizeFrame(m: MemberRole, frame: FrameKind, mute: MuteState): FrameDecision {
  const kind = frame.k;
  if (kind === undefined) return { ok: false, error: 'forbidden' };
  const roles = Object.hasOwn(KIND_MIN_ROLE, kind)
    ? KIND_MIN_ROLE[kind]
    : CATALOGUED.has(kind)
      ? SERVER
      : UNKNOWN_KIND_ROLES;
  if (roles === undefined || !roles.includes(m.role)) return { ok: false, error: 'forbidden' };
  if (MUTED_FRAME_TYPES.has(frame.t) && mute.isMuted(m.sid, m.id))
    return { ok: false, error: 'muted' };
  return { ok: true };
}

/** A mute state where nobody is muted (until B051 keeps one). */
export const noMutes: MuteState = Object.freeze({ isMuted: () => false });

/** A mute state in memory, for tests and until B051 stores mutes. */
export function memoryMuteState(): MuteState & {
  mute(sid: string, memberId: string): void;
  unmute(sid: string, memberId: string): void;
} {
  const muted = new Set<string>();
  return {
    isMuted: (sid, memberId) => muted.has(`${sid}:${memberId}`),
    mute: (sid, memberId) => void muted.add(`${sid}:${memberId}`),
    unmute: (sid, memberId) => void muted.delete(`${sid}:${memberId}`),
  };
}
