/**
 * B060 notification event (scope_in: "Event to the notification dispatcher (category
 * approval_needed, params agent/session/risk) through a NotifyPort"; CT-NOTIF-PAYLOAD): the
 * dispatcher adapter publishes one `approval_needed` event with `params {agent, session, risk}`
 * only, for the session members who may decide the approval now (never the requester unless the
 * host, never viewers), high priority for a high risk, deduped by the approval id; nothing when
 * nobody may decide; a failure is counted and never thrown at the router.
 */
import { newId } from '@centcom/contracts';
import type { NotificationEvent } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { dispatcherNotify, type SessionDecider } from '../../src/approvals/notify.js';
import type { ApprovalNotice } from '../../src/approvals/ports.js';
import { recordingMetrics } from '../helpers.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Members of each role; `approvers` picks the policy's approvers from them. */
function setup(
  over: {
    fail?: boolean;
    approvers?: (m: { other: string; viewer: string }) => string[];
  } = {},
) {
  const sid = newId('ses');
  const ids = {
    host: newId('mem'),
    editor: newId('mem'),
    other: newId('mem'),
    admin: newId('mem'),
    viewer: newId('mem'),
  };
  const members: SessionDecider[] = [
    { memberId: ids.host, role: 'host', workspaceRole: 'owner' },
    { memberId: ids.editor, role: 'editor', workspaceRole: 'member' },
    { memberId: ids.other, role: 'editor', workspaceRole: 'member' },
    { memberId: ids.admin, role: 'editor', workspaceRole: 'admin' },
    { memberId: ids.viewer, role: 'viewer', workspaceRole: 'guest' },
  ];
  const published: NotificationEvent[] = [];
  const recorded = recordingMetrics();
  const port = dispatcherNotify({
    publisher: {
      publish(event) {
        if (over.fail === true) return Promise.reject(new Error('queue down'));
        published.push(event);
        return Promise.resolve('evt');
      },
    },
    members: () => Promise.resolve(members),
    approvers: () => Promise.resolve(over.approvers?.(ids) ?? []),
    metrics: recorded.metrics,
  });
  const notice = (a: Partial<ApprovalNotice>): ApprovalNotice => ({
    approvalId: newId('apr'),
    agentId: newId('agt'),
    risk: 'medium',
    approver: 'host',
    requester: ids.editor,
    ...a,
  });
  const to = () => (published[0]?.recipients as { members: string[] } | undefined)?.members;
  return { sid, ...ids, port, published, recorded, notice, to };
}

describe('the approval_needed event', () => {
  it('goes to who may decide, with ids and enums only', async () => {
    const env = setup();
    const a = env.notice({ approver: 'any_editor', risk: 'high' });
    env.port.approvalNeeded(env.sid, a);
    await settle();
    expect(env.published).toEqual([
      {
        category: 'approval_needed',
        recipients: { session: env.sid, members: [env.host, env.other, env.admin] },
        params: { agent: a.agentId, session: env.sid, risk: 'high' },
        priority: 'high',
        dedupeKey: `approval:${a.approvalId}`,
        action: { type: 'open_session' },
      },
    ]);
  });

  it('approver host: the host only; owner: the host and workspace admins and owners', async () => {
    const host = setup();
    host.port.approvalNeeded(host.sid, host.notice({ approver: 'host' }));
    const owner = setup();
    owner.port.approvalNeeded(owner.sid, owner.notice({ approver: 'owner' }));
    await settle();
    expect(host.to()).toEqual([host.host]);
    expect(owner.to()).toEqual([owner.host, owner.admin]);
    expect(host.published[0]?.priority).toBe('normal');
  });

  it('includes policy approvers, never a viewer or the requester', async () => {
    const env = setup({ approvers: (m) => [m.other, m.viewer] });
    env.port.approvalNeeded(env.sid, env.notice({ approver: 'host' }));
    await settle();
    expect(env.to()).toEqual([env.host, env.other]);
    const own = setup({ approvers: (m) => [m.other] });
    // The other editor asks: as a policy approver they still never get their own request.
    own.port.approvalNeeded(own.sid, own.notice({ approver: 'any_editor', requester: own.other }));
    await settle();
    expect(own.to()).toEqual([own.host, own.editor, own.admin]);
  });

  it('a failing dispatcher is counted, never thrown', async () => {
    const env = setup({ fail: true });
    expect(() => env.port.approvalNeeded(env.sid, env.notice({}))).not.toThrow();
    await settle();
    expect(env.recorded.count('relay_approval_notify_failures_total')).toBe(1);
  });
});
