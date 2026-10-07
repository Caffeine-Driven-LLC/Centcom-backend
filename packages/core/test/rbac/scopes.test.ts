/**
 * Scopes (B021, card test scopes.test.ts): exact names only, subsets, unknown scopes and
 * malformed principals never pass; API keys act within their scopes and their own workspace, and
 * never on sessions (acceptance 4).
 */
import { describe, expect, it } from 'vitest';
import {
  can,
  hasScope,
  hasScopes,
  isScope,
  SCOPES,
  SESSION_ACTIONS,
  type Actor,
  type Scope,
} from '../../src/index.js';
import { OTHER_WORKSPACE, SESSION, WORKSPACE } from './helpers.js';

const key = (scopes: string[], workspaceId = WORKSPACE): Actor => ({
  kind: 'api_key',
  keyId: 'key_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
  workspaceId,
  scopes,
});

describe('hasScope and hasScopes', () => {
  it('match exact names only: no wildcard, no implication', () => {
    const holder = { scopes: ['workspaces:write', 'profile'] };
    expect(hasScope(holder, 'workspaces:write')).toBe(true);
    expect(hasScope(holder, 'workspaces:read')).toBe(false);
    expect(hasScope({ scopes: ['workspaces:*'] }, 'workspaces:read')).toBe(false);
    expect(hasScope({ scopes: ['admin'] }, 'billing:read')).toBe(false);
  });

  it('require every scope of a subset, and hold the empty one', () => {
    const holder = { scopes: ['profile', 'sessions:read', 'sessions:write'] };
    expect(hasScopes(holder, ['profile', 'sessions:read'])).toBe(true);
    expect(hasScopes(holder, ['profile', 'sessions:host'])).toBe(false);
    expect(hasScopes(holder, [])).toBe(true);
  });

  it('never pass an unknown scope or a malformed principal', () => {
    expect(hasScope({ scopes: ['root'] }, 'root' as Scope)).toBe(false);
    for (const holder of [
      null,
      undefined,
      {},
      { scopes: 'profile' },
      { scopes: [42] },
    ] as never[]) {
      expect(hasScope(holder, 'profile')).toBe(false);
    }
    expect(SCOPES.every(isScope)).toBe(true);
    expect(isScope('sessions:*')).toBe(false);
  });
});

describe('API keys', () => {
  it('are denied every session action, joining as viewer included, whatever their scopes (acceptance 4)', () => {
    const everything = key([...SCOPES]);
    for (const action of [
      ...SESSION_ACTIONS,
      'session.create',
      'session.join.editor',
      'session.join.viewer',
    ] as const) {
      expect(
        can(
          everything,
          action,
          { workspaceId: WORKSPACE, sessionId: SESSION },
          { sessionRole: 'host', workspaceRole: 'owner' },
        ),
      ).toEqual({
        allow: false,
        reason: 'api_key',
      });
    }
  });

  it('act within their scopes on their own workspace only', () => {
    expect(can(key(['workspaces:read']), 'workspace.read', { workspaceId: WORKSPACE })).toEqual({
      allow: true,
    });
    expect(can(key(['workspaces:read']), 'workspace.update', { workspaceId: WORKSPACE })).toEqual({
      allow: false,
      reason: 'scope',
    });
    expect(can(key(['workspaces:write']), 'workspace.update', { workspaceId: WORKSPACE })).toEqual({
      allow: true,
    });
    expect(
      can(key(['workspaces:read']), 'workspace.read', { workspaceId: OTHER_WORKSPACE }),
    ).toEqual({
      allow: false,
      reason: 'other_workspace',
    });
    expect(can(key(['workspaces:read']), 'workspace.read', {})).toEqual({
      allow: false,
      reason: 'other_workspace',
    });
    expect(can(key(['billing:read']), 'billing.read', { workspaceId: WORKSPACE }).allow).toBe(true);
    expect(can(key(['audit:read']), 'audit.read', { workspaceId: WORKSPACE }).allow).toBe(true);
    expect(can(key(['webhooks:write']), 'webhook.manage', { workspaceId: WORKSPACE }).allow).toBe(
      true,
    );
    // Memberships, ownership and keys are people's decisions.
    for (const action of [
      'member.invite',
      'member.role.change',
      'workspace.delete',
      'apikey.manage.own',
    ] as const) {
      expect(can(key([...SCOPES]), action, { workspaceId: WORKSPACE }), action).toEqual({
        allow: false,
        reason: 'api_key',
      });
    }
  });
});
