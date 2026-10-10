/**
 * Who may do what with a control frame (B051, CT-WS-CONTROL "Authority", CT-RBAC): checked right
 * before the frame is sequenced, from the records as they are now.
 *
 * - **Sender:** the live record is read again (no cache), so a host whose role changed a moment
 *   ago, on any node, is refused: "the relay checks the sender's live role at sequencing time".
 *   Only the host may send a client control kind; anyone else gets `forbidden`. (B043's stage at
 *   order 20 already refuses non-hosts from its 2 s cache; this is the fresh check.)
 * - **Target** (`p.member`, or `p.to` for a transfer):
 *   - a current member of the session, else `not_found`;
 *   - not the sender (`conflict`: the host cannot kick, mute or demote themselves, or transfer to
 *     themselves);
 *   - for `control.transfer_host`: an editor (`conflict` for a viewer) connected on some node
 *     (`conflict` when offline).
 * - **`control.mute`'s `until`:** a time in the future, else `invalid_frame` at `/p/until`.
 *
 * Reading the records may throw: the caller fails closed (`service_unavailable`).
 *
 * Owns: the rules. Must not: change anything (the handler applies the frame once it has a `seq`).
 */
import type { ErrorCode } from '@centcom/core';
import type { LiveMember } from '../rooms/membership.js';
import type { ConnectionRegistryPort, MembershipPort } from './ports.js';

/** The control kinds a client (the host) may send. */
export const CLIENT_CONTROL_KINDS = [
  'control.kick',
  'control.mute',
  'control.unmute',
  'control.role',
  'control.transfer_host',
  'control.end',
  'control.policy',
] as const;

/** A client control kind. */
export type ControlKind = (typeof CLIENT_CONTROL_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set(CLIENT_CONTROL_KINDS);

/** True for a kind this lane handles. */
export const isClientControlKind = (kind: unknown): kind is ControlKind =>
  typeof kind === 'string' && KINDS.has(kind);

/** The details of the refusals (GUIDELINES §3.4). */
export const CONTROL_DETAILS = Object.freeze({
  hostOnly: 'Only the session host can do that.',
  notAMember: 'That member is not in this session.',
  self: 'You cannot do that to yourself.',
  notEditor: 'The host role can only go to an editor.',
  offline: 'The host role can only go to a member who is connected.',
  untilPast: 'A mute must end in the future.',
  policy: 'That policy is not valid.',
  unavailable: 'The relay cannot apply that right now; try again shortly.',
  ended: 'The session has already ended.',
  changed: 'The member changed while this was being applied; try again.',
} as const);

/** A refusal: the error code, its detail, and the field it is about. */
export interface Refusal {
  refused: true;
  code: ErrorCode;
  detail: string;
  pointer?: string;
}

/** An accepted frame: the sender's record, and the target's when the kind has one. */
export interface Authorised {
  refused: false;
  sender: LiveMember;
  /** `p.member` or `p.to`. */
  target?: string;
  /** For `control.mute`: when it ends (ms since the epoch), or null until unmuted. */
  until?: number | null;
}

const refuse = (code: ErrorCode, detail: string, pointer?: string): Refusal => ({
  refused: true,
  code,
  detail,
  ...(pointer === undefined ? {} : { pointer }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The member a kind acts on (`p.member`, `p.to`), and its pointer; undefined for none. */
export function targetOf(kind: string, p: unknown): { id: string; pointer: string } | undefined {
  if (!isRecord(p)) return undefined;
  const field = kind === 'control.transfer_host' ? 'to' : 'member';
  if (kind === 'control.end' || kind === 'control.policy') return undefined;
  const id = p[field];
  return typeof id === 'string' ? { id, pointer: `/p/${field}` } : undefined;
}

/** What the checks read. */
export interface AuthorityDeps {
  membership: Pick<MembershipPort, 'get'>;
  connections: Pick<ConnectionRegistryPort, 'isConnected'>;
  /** Milliseconds since the epoch. */
  clock: () => number;
}

/** Whether `senderId` may send `kind` with `p` in `sid` now. Throws when the records cannot be read. */
export async function checkAuthority(
  deps: AuthorityDeps,
  sid: string,
  senderId: string,
  kind: ControlKind,
  p: unknown,
): Promise<Authorised | Refusal> {
  const sender = await deps.membership.get(sid, senderId);
  if (sender === null || sender.role !== 'host')
    return refuse('forbidden', CONTROL_DETAILS.hostOnly);
  if (kind === 'control.end' || kind === 'control.policy') return { refused: false, sender };
  const target = targetOf(kind, p);
  if (target === undefined) return refuse('invalid_frame', CONTROL_DETAILS.notAMember, '/p');
  if (target.id === senderId) return refuse('conflict', CONTROL_DETAILS.self, target.pointer);
  const live = await deps.membership.get(sid, target.id);
  if (live === null) return refuse('not_found', CONTROL_DETAILS.notAMember, target.pointer);
  if (live.role === 'host') return refuse('conflict', CONTROL_DETAILS.self, target.pointer);
  if (kind === 'control.transfer_host') {
    if (live.role !== 'editor')
      return refuse('conflict', CONTROL_DETAILS.notEditor, target.pointer);
    if (!(await deps.connections.isConnected(sid, target.id))) {
      return refuse('conflict', CONTROL_DETAILS.offline, target.pointer);
    }
  }
  if (kind === 'control.mute') {
    const raw = isRecord(p) ? p['until'] : undefined;
    if (raw === undefined || raw === null)
      return { refused: false, sender, target: target.id, until: null };
    const until = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(until) || until <= deps.clock()) {
      return refuse('invalid_frame', CONTROL_DETAILS.untilPast, '/p/until');
    }
    return { refused: false, sender, target: target.id, until };
  }
  return { refused: false, sender, target: target.id };
}
