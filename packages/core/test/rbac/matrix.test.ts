/**
 * The CT-RBAC matrix (B021 acceptance 1, 2 and 3, card test matrix.test.ts): every cell of the
 * workspace and session tables, read from contracts/01-auth-rbac.md, against `can`. Plain ✓ and —
 * cells are checked as they are; each conditional cell is checked with its condition met and not
 * met. A cell text the test does not know fails, so a contract change is noticed here.
 */
import { describe, expect, it } from 'vitest';
import {
  can,
  defaultSessionRole,
  type Decision,
  type Resource,
  type SessionAction,
  type SessionRole,
  type WorkspaceAction,
  type WorkspaceRole,
} from '../../src/index.js';
import {
  ACTOR_ID,
  contractTable,
  OTHER_ID,
  SESSION,
  SESSION_ROWS,
  user,
  WORKSPACE,
  WORKSPACE_ROWS,
} from './helpers.js';

/** A resource meeting every condition but ownership: another member's things. */
const BASE: Resource = {
  workspaceId: WORKSPACE,
  sessionId: SESSION,
  ownerUserId: OTHER_ID,
  targetRole: 'member',
  newRole: 'billing',
  invited: true,
  sessionMode: 'branch',
};

const ws = (action: WorkspaceAction, role: WorkspaceRole, resource: Resource = BASE): Decision =>
  can(user(), action, resource, { workspaceRole: role });
const ses = (
  action: SessionAction,
  role: SessionRole,
  resource: Resource = BASE,
  delegatedApprover = false,
): Decision =>
  can(user(), action, resource, {
    sessionRole: role,
    ...(delegatedApprover ? { delegatedApprover } : {}),
  });

describe('the workspace table of CT-RBAC (acceptance 1)', () => {
  const table = contractTable('Action');

  it('has the roles and rows this test knows', () => {
    expect(table.roles).toEqual(['owner', 'admin', 'member', 'billing', 'guest']);
    expect(table.rows.map((row) => row.label)).toEqual(Object.keys(WORKSPACE_ROWS));
  });

  for (const { label, cells } of table.rows) {
    for (const [i, cell] of cells.entries()) {
      const role = table.roles[i] as WorkspaceRole;
      it(`${label} / ${role}: ${cell}`, () => {
        const actions = WORKSPACE_ROWS[label] ?? [];
        expect(actions.length).toBeGreaterThan(0);
        switch (cell) {
          case '✓':
            for (const action of actions) expect(ws(action, role), action).toEqual({ allow: true });
            return;
          case '—':
            for (const action of actions) expect(ws(action, role).allow, action).toBe(false);
            return;
          case '✓ (limited)':
            // A guest reads a reduced view: allowed, flagged limited.
            expect(ws('workspace.read', role)).toEqual({ allow: true, limited: true });
            return;
          case '✓ (not owner)':
            // Resolved in v1.1.0: an admin assigns member, billing or guest, never to or from admin or owner.
            expect(
              ws('member.role.change', role, { ...BASE, targetRole: 'member', newRole: 'guest' }),
            ).toEqual({ allow: true });
            expect(
              ws('member.role.change', role, { ...BASE, targetRole: 'owner', newRole: 'member' })
                .allow,
            ).toBe(false);
            expect(
              ws('member.role.change', role, { ...BASE, targetRole: 'member', newRole: 'admin' })
                .allow,
            ).toBe(false);
            expect(
              ws('member.role.change', role, { ...BASE, targetRole: 'admin', newRole: 'member' })
                .allow,
            ).toBe(false);
            return;
          case '✓ (if invited)':
            expect(ws('session.join.viewer', role, { ...BASE, invited: true })).toEqual({
              allow: true,
            });
            expect(ws('session.join.viewer', role, { ...BASE, invited: false }).allow).toBe(false);
            expect(ws('session.join.editor', role).allow).toBe(false);
            return;
          case 'own keys only':
            expect(ws('apikey.manage.own', role, { ...BASE, ownerUserId: ACTOR_ID })).toEqual({
              allow: true,
            });
            expect(ws('apikey.manage.own', role, { ...BASE, ownerUserId: OTHER_ID }).allow).toBe(
              false,
            );
            expect(ws('apikey.manage.any', role).allow).toBe(false);
            expect(ws('webhook.manage', role).allow).toBe(false);
            return;
          default:
            throw new Error(`a cell this test does not know: ${JSON.stringify(cell)}`);
        }
      });
    }
  }

  it('lets the owner assign any role but a second owner, and never change the owner (resolved in v1.1.0)', () => {
    for (const newRole of ['admin', 'member', 'billing', 'guest'] as const) {
      expect(
        ws('member.role.change', 'owner', { ...BASE, targetRole: 'member', newRole }).allow,
        newRole,
      ).toBe(true);
    }
    expect(
      ws('member.role.change', 'owner', { ...BASE, targetRole: 'admin', newRole: 'member' }).allow,
    ).toBe(true);
    expect(
      ws('member.role.change', 'owner', { ...BASE, targetRole: 'member', newRole: 'owner' }).allow,
    ).toBe(false);
    expect(
      ws('member.role.change', 'owner', { ...BASE, targetRole: 'owner', newRole: 'admin' }).allow,
    ).toBe(false);
    // Without the roles involved there is nothing to decide on: denied.
    expect(ws('member.role.change', 'owner', { workspaceId: WORKSPACE }).allow).toBe(false);
  });

  it('lets an admin remove ordinary members only, the owner anyone but themselves, and anyone but the owner leave', () => {
    expect(ws('member.remove', 'admin', { ...BASE, targetRole: 'admin' }).allow).toBe(false);
    expect(ws('member.remove', 'owner', { ...BASE, targetRole: 'admin' }).allow).toBe(true);
    expect(ws('member.remove', 'owner', { ...BASE, targetRole: 'owner' }).allow).toBe(false);
    // CT-API-WORKSPACES: DELETE …/members/{mem} is "admin+ / self".
    for (const role of ['member', 'billing', 'guest', 'admin'] as const) {
      expect(
        ws('member.remove', role, { ...BASE, ownerUserId: ACTOR_ID, targetRole: role }).allow,
        role,
      ).toBe(true);
    }
    expect(
      ws('member.remove', 'owner', { ...BASE, ownerUserId: ACTOR_ID, targetRole: 'owner' }).allow,
    ).toBe(false);
  });

  it('cites the examples of the card: billing cannot create a session, admin cannot change an owner, member manages own keys only', () => {
    expect(ws('session.create', 'billing').allow).toBe(false);
    expect(
      ws('member.role.change', 'admin', { ...BASE, targetRole: 'owner', newRole: 'member' }).allow,
    ).toBe(false);
    expect(ws('apikey.manage.own', 'member', { ...BASE, ownerUserId: ACTOR_ID }).allow).toBe(true);
    expect(ws('apikey.manage.own', 'member', { ...BASE, ownerUserId: OTHER_ID }).allow).toBe(false);
  });
});

describe('the session table of CT-RBAC (acceptance 2)', () => {
  const table = contractTable('Session action');

  it('has the roles and rows this test knows', () => {
    expect(table.roles).toEqual(['host', 'editor', 'viewer']);
    expect(table.rows.map((row) => row.label)).toEqual(Object.keys(SESSION_ROWS));
  });

  for (const { label, cells } of table.rows) {
    for (const [i, cell] of cells.entries()) {
      const role = table.roles[i] as SessionRole;
      it(`${label} / ${role}: ${cell}`, () => {
        const actions = SESSION_ROWS[label] ?? [];
        expect(actions.length).toBeGreaterThan(0);
        switch (cell) {
          case '✓':
            for (const action of actions)
              expect(ses(action, role), action).toEqual({ allow: true });
            if (label.includes('(branch mode)')) {
              for (const action of actions) {
                expect(
                  ses(action, role, { ...BASE, sessionMode: 'command_post' }).allow,
                  action,
                ).toBe(false);
              }
            }
            return;
          case '—':
            for (const action of actions) expect(ses(action, role).allow, action).toBe(false);
            return;
          case '✓ (and delegated approvers)':
            expect(ses('session.tool.approve', role)).toEqual({ allow: true });
            return;
          case '✓ (reactions, comments only)':
            expect(ses('session.react', role)).toEqual({ allow: true });
            expect(ses('session.comment', role)).toEqual({ allow: true });
            expect(ses('session.presence', role).allow).toBe(false);
            return;
          default:
            throw new Error(`a cell this test does not know: ${JSON.stringify(cell)}`);
        }
      });
    }
  }

  it('lets delegated approvers approve tool calls whatever their role, and nothing else', () => {
    for (const role of ['editor', 'viewer'] as const) {
      expect(ses('session.tool.approve', role, BASE, true)).toEqual({ allow: true });
      expect(ses('session.queue.decide', role, BASE, true).allow).toBe(false);
    }
  });

  it('matches the card: viewers cannot send message.user or submit, editors cannot decide the queue, only the host controls', () => {
    expect(ses('session.message.send', 'viewer').allow).toBe(false);
    expect(ses('session.queue.submit', 'viewer').allow).toBe(false);
    expect(ses('session.queue.decide', 'editor').allow).toBe(false);
    for (const role of ['editor', 'viewer'] as const)
      expect(ses('session.control', role).allow).toBe(false);
    expect(ses('session.control', 'host').allow).toBe(true);
    expect(ses('session.react', 'viewer').allow).toBe(true);
    expect(ses('session.comment', 'viewer').allow).toBe(true);
  });
});

describe('defaultSessionRole (acceptance 3)', () => {
  it('gives guests viewer and owner, admin and member editor', () => {
    expect(defaultSessionRole('guest')).toBe('viewer');
    for (const role of ['owner', 'admin', 'member'] as const)
      expect(defaultSessionRole(role)).toBe('editor');
    // billing may not join; should one be added anyway, it gets the least privilege.
    expect(defaultSessionRole('billing')).toBe('viewer');
  });
});
