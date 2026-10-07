/**
 * Coverage of the catalogue (B021 guardrail "every new action requires an explicit matrix rule",
 * card test coverage.test.ts): every action has exactly one rule citing a real contract row, every
 * contract row is governed by at least one action, and the row mapping of the matrix test agrees
 * with the rules.
 */
import { describe, expect, it } from 'vitest';
import { ACTIONS, MATRIX, SESSION_ACTIONS, WORKSPACE_ACTIONS } from '../../src/index.js';
import { contractTable, SESSION_ROWS, WORKSPACE_ROWS } from './helpers.js';

describe('the action catalogue', () => {
  it('has a rule for every action and no rule without an action', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
  });

  it('decides workspace actions by workspace role and session actions by session role', () => {
    for (const action of WORKSPACE_ACTIONS) expect(MATRIX[action].kind, action).toBe('workspace');
    for (const action of SESSION_ACTIONS) expect(MATRIX[action].kind, action).toBe('session');
  });

  it('cites a row that exists in the contract tables, and the same row the matrix test maps it to', () => {
    const workspaceRows = contractTable('Action').rows.map((row) => row.label);
    const sessionRows = contractTable('Session action').rows.map((row) => row.label);
    for (const action of WORKSPACE_ACTIONS) {
      expect(workspaceRows, action).toContain(MATRIX[action].row);
      expect(WORKSPACE_ROWS[MATRIX[action].row], action).toContain(action);
    }
    for (const action of SESSION_ACTIONS) {
      expect(sessionRows, action).toContain(MATRIX[action].row);
      expect(SESSION_ROWS[MATRIX[action].row], action).toContain(action);
    }
  });

  it('governs every contract row with at least one action', () => {
    const cited = new Set(ACTIONS.map((action) => MATRIX[action].row));
    for (const { label } of [
      ...contractTable('Action').rows,
      ...contractTable('Session action').rows,
    ]) {
      expect(cited.has(label), label).toBe(true);
    }
  });

  it('lets API keys only near workspace reads and writes their scope names, never sessions or memberships', () => {
    for (const action of SESSION_ACTIONS)
      expect('apiKeyScope' in MATRIX[action], action).toBe(false);
    for (const action of [
      'member.invite',
      'member.remove',
      'member.role.change',
      'workspace.transfer',
      'workspace.delete',
      'apikey.manage.any',
      'apikey.manage.own',
    ] as const) {
      expect(MATRIX[action].apiKeyScope, action).toBeUndefined();
    }
  });
});
