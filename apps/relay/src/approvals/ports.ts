/**
 * Approval routing ports and types (B060, CT-WS-SESSION-EVENTS `approval.request` and
 * `approval.decision`): what the router stores about a pending approval (ids, enums and times
 * only), who may decide, and the ports it reaches the rest of the relay through.
 *
 * Owns: the shapes and bounds. Must not: carry anything from `ct` (summary, command, cwd, reason).
 */
import type { ErrorCode } from '@centcom/core';
import type { SessionRole } from '../rooms/kind-policy.js';
import type { StoredFrame } from '../seq/types.js';

/** CT-WS-SESSION-EVENTS `approval.request.risk`. */
export type Risk = 'low' | 'medium' | 'high';
/** Who the request names as its approver (CT-WS-SESSION-EVENTS "`approver` meaning"). */
export type Approver = 'host' | 'owner' | 'any_editor';
/** `approval.decision.decision`. */
export type Decision = 'approve' | 'deny';

export const RISKS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
export const APPROVERS: ReadonlySet<string> = new Set(['host', 'owner', 'any_editor']);
export const DECISIONS: ReadonlySet<string> = new Set(['approve', 'deny']);
export const SCOPES: ReadonlySet<string> = new Set(['once', 'session', 'always']);

/** CT-WS-SESSION-EVENTS "Limits": `expires_at` is at most 24 h after the frame. */
export const MAX_EXPIRY_AHEAD_MS = 24 * 3_600_000;
/** An approval's Redis keys outlive its `expires_at` by this much (the card's TTL). */
export const APPROVAL_KEY_GRACE_MS = 60_000;

/** A pending approval, as stored. */
export interface PendingApproval {
  /** `apr_`. */
  approvalId: string;
  /** `agt_`. */
  agentId: string;
  /** The member who sent the request (`mem_`). */
  requester: string;
  risk: Risk;
  approver: Approver;
  /** RFC 3339, as the request said. */
  expiresAt: string;
  /** When the relay took the request (milliseconds since the epoch; for the decision latency). */
  requestedAt: number;
  /** The request's seq; 0 until it is sequenced. */
  requestSeq: number;
  /** The request frame's id (a resend of it is the same request). */
  frameId: string;
}

/** Who answered an approval: a member's frame, or the server's timeout. */
export interface DecisionClaim {
  /** `mem_`, or `srv` for the timeout deny. */
  by: string;
  /** The deciding frame's id (`expiry` for the timeout). */
  frameId: string;
  /** The decision's seq, once it is sequenced (a resend is then acked again). */
  seq?: number;
  /** When the claim was taken (milliseconds since the epoch). */
  at?: number;
  /** The request's frame id and sender, so that frame sent again is recognised. */
  requestFrame?: string;
  requester?: string;
  /** The approval's `expires_at` (a decision never recorded must not land after it). */
  expiresAt?: string;
}

/** The decider as the records say now (CT-RBAC rule 2: never the ticket's or the frame's). */
export interface Decider {
  role: SessionRole;
  userId: string;
  /** The session's workspace; null outside one. */
  workspaceId: string | null;
  /** The user's role in that workspace (`owner`, `admin`, `member`, ...); null outside one. */
  workspaceRole: string | null;
}

/** Live membership and the session's delegated approvers. */
export interface DeciderPort {
  /** Member `mid` of `sid` now; null when not a current member. */
  get(sid: string, mid: string): Promise<Decider | null>;
  /** `control.policy.approvers` of `sid` (B051's policy). */
  approvers(sid: string): Promise<readonly string[]>;
}

/** The owner of an agent (B057's registry). */
export interface AgentOwnerPort {
  /** `agt_`'s owning member, or undefined for an agent the session does not know. */
  ownerOf(sid: string, agentId: string): Promise<string | undefined>;
}

/** What a notification is about: ids and enums only. */
export interface ApprovalNotice {
  approvalId: string;
  agentId: string;
  risk: Risk;
  /** Who may decide (for the recipients), and who asked (never notified unless the host). */
  approver: Approver;
  requester: string;
}

/** The notification dispatcher (CT-NOTIF-PAYLOAD `approval_needed {agent, session, risk}`). */
export interface NotifyPort {
  approvalNeeded(sid: string, a: ApprovalNotice): void;
}

/** Sequences the server's timeout deny (`approval.decision {decision:'deny', scope:'once'}`). */
export interface ApprovalEmitter {
  emitTimeout(sid: string, approvalId: string): Promise<void>;
}

/** Persistence of pending approvals and their decisions. */
export interface ApprovalStore {
  /** Writes `a` unless its approval id exists (SET NX); resolves to the existing one if it does. */
  create(sid: string, a: PendingApproval, ttlMs: number): Promise<PendingApproval | null>;
  get(sid: string, approvalId: string): Promise<PendingApproval | null>;
  /** Replaces a pending approval (its request seq once sequenced). */
  update(sid: string, a: PendingApproval, ttlMs: number): Promise<void>;
  /** Forgets a pending approval (its key and its place in the session's list). */
  remove(sid: string, approvalIds: readonly string[]): Promise<void>;
  /** The session's pending approvals. */
  list(sid: string): Promise<PendingApproval[]>;
  /** Claims the decision (SET NX, kept a day): true when this claim won; else the claim that holds. */
  claim(sid: string, approvalId: string, c: DecisionClaim): Promise<true | DecisionClaim>;
  /** Marks a claim's decision as sequenced at `seq`. */
  settle(sid: string, approvalId: string, c: DecisionClaim, seq: number): Promise<void>;
  /** Undoes a claim whose frame could not be sequenced (never one already settled). */
  release(sid: string, approvalId: string, c: DecisionClaim): Promise<void>;
  /** The claim on an approval, if any. */
  claimOf(sid: string, approvalId: string): Promise<DecisionClaim | null>;
}

/** The sender of a frame. */
export interface ApprovalSender {
  memberId: string;
  role: SessionRole;
}

/** What `onRequest`/`onDecision` get with a frame. */
export interface ApprovalContext {
  sid: string;
  sender: ApprovalSender;
  /**
   * Runs the rest of the pipeline. The stored frame once sequenced; with `duplicate` when it had
   * been sequenced before (B041 echoes its original place again); `unknown` when the store failed
   * while assigning it (it may be stored); undefined when refused before the store was asked.
   */
  sequence(): Promise<SequenceResult | 'unknown' | undefined>;
}

/** What sequencing a frame gave. */
export interface SequenceResult {
  frame: StoredFrame;
  /** The frame had been sequenced before (a resend). */
  duplicate: boolean;
}

/** An approval frame: its id and cleartext `p`. */
export interface ApprovalFrame {
  id: string;
  p: unknown;
}

/** What the router did with a frame. */
export type ApprovalResult =
  | { outcome: 'sequenced' }
  /** A resend of a frame already handled: passed on so the sequencer acks it again. */
  | { outcome: 'duplicate' }
  /** Sequencing refused it (the sequencer answered the sender); nothing kept. */
  | { outcome: 'ignored' }
  | { outcome: 'refused'; code: ErrorCode; detail: string };
