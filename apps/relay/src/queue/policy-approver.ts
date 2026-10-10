/**
 * Auto-approval (B052, CT-WS-QUEUE rule 3): whether the session's policy (B051's
 * `control.policy`) approves a newly submitted item without the host.
 *
 * - `ask` (the default): never.
 * - `trusted`: an editor whose member id is in `policy.trusted`.
 * - `everyone`: every editor.
 *
 * The host's own items are never auto-approved (the host approves them). Nothing is auto-approved
 * while approvals are paused: the policy's `queue_paused` (CT-PROVIDER §5) or the quota hook
 * (`setApprovalsPaused`). The relay then emits `queue.approve` itself, from `srv`, carrying
 * the policy as its reason, so the audit trail shows the policy and never the submitter.
 *
 * Owns: the decision. Must not: emit anything (the service does).
 */
import type { SessionRole } from '../rooms/kind-policy.js';
import type { QueuePolicy } from './ports.js';

/** Why the relay approved an item: the policy that did it. */
export type AutoApproval = 'everyone' | 'trusted';

/** The policy that approves `submitter`'s new item, or null when the host must. */
export function autoApproval(
  policy: Pick<QueuePolicy, 'auto_approve' | 'trusted' | 'queue_paused'>,
  submitter: { id: string; role: SessionRole },
  approvalsPaused: boolean,
): AutoApproval | null {
  if (approvalsPaused || policy.queue_paused || submitter.role !== 'editor') return null;
  if (policy.auto_approve === 'everyone') return 'everyone';
  if (policy.auto_approve === 'trusted' && policy.trusted.includes(submitter.id)) return 'trusted';
  return null;
}

/** The id of the relay's `queue.approve` for item `item` (`que_…`): fixed, so a retry dedupes. */
export function autoApproveId(item: string): string {
  return `msg_${item.slice('que_'.length)}`;
}
