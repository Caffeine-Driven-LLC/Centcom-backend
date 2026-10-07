/**
 * Default deny (B021 acceptance 6, card test can.fuzz.test.ts): an unknown action or role is
 * denied, and 1 000 fuzzed combinations with at least one unknown or malformed part neither throw
 * nor allow. Deterministic: the combinations come from a seeded generator.
 */
import { describe, expect, it } from 'vitest';
import { ACTIONS, can, SESSION_ROLES, WORKSPACE_ROLES, type Action } from '../../src/index.js';
import { user, WORKSPACE } from './helpers.js';

/** A small seeded generator (mulberry32), so a failure reproduces. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: unknown[] = [
  undefined,
  null,
  '',
  'OWNER',
  'root',
  'superadmin',
  42,
  NaN,
  {},
  [],
  'owner ',
  'host\u0000',
  'toString',
  '__proto__',
  'constructor',
  true,
  () => 'owner',
  Symbol('role'),
];

describe('default deny', () => {
  it('denies an unknown action and an unknown role', () => {
    expect(
      can(
        user(),
        'workspace.nuke' as Action,
        { workspaceId: WORKSPACE },
        { workspaceRole: 'owner' },
      ),
    ).toEqual({
      allow: false,
      reason: 'unknown_action',
    });
    expect(
      can(
        user(),
        'workspace.read',
        { workspaceId: WORKSPACE },
        { workspaceRole: 'superadmin' as never },
      ),
    ).toEqual({
      allow: false,
      reason: 'not_a_member',
    });
    expect(can(user(), 'workspace.read', { workspaceId: WORKSPACE }, {})).toEqual({
      allow: false,
      reason: 'not_a_member',
    });
    expect(can(user(), 'session.react', {}, { sessionRole: 'audience' as never }).allow).toBe(
      false,
    );
  });

  it('neither throws nor allows on 1 000 fuzzed combinations with an unknown or malformed part', () => {
    const random = seeded(20261007);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const actors: unknown[] = [
      user(),
      { kind: 'robot', userId: 'x' },
      { kind: 'user' },
      { kind: 'user', userId: '' },
      null,
      undefined,
      'user',
      {},
    ];
    let checked = 0;
    for (let i = 0; i < 1_000; i++) {
      // Which part is broken: the action, the role, the actor, or all of them.
      const broken = Math.floor(random() * 4);
      const action =
        broken === 0 || broken === 3
          ? pick([...JUNK, 'workspace.*', 'session', 'billing.read '])
          : pick(ACTIONS);
      const workspaceRole =
        broken === 1 || broken === 3 ? pick(JUNK) : pick([...WORKSPACE_ROLES, undefined]);
      const sessionRole =
        broken === 1 || broken === 3 ? pick(JUNK) : pick([...SESSION_ROLES, undefined]);
      const actor = broken === 2 || broken === 3 ? pick(actors.slice(1)) : pick(actors);
      // With a valid action, actor and roles the call may rightly allow; keep only broken ones.
      const roleBroken =
        !(WORKSPACE_ROLES as readonly unknown[]).includes(workspaceRole) &&
        !(SESSION_ROLES as readonly unknown[]).includes(sessionRole);
      const actionBroken = !(ACTIONS as readonly unknown[]).includes(action);
      const actorBroken = actor !== actors[0];
      if (!(roleBroken || actionBroken || actorBroken)) continue;
      const resource = pick<unknown>([
        { workspaceId: WORKSPACE, targetRole: pick(JUNK), newRole: pick(JUNK) },
        null,
        'resource',
        undefined,
        {},
      ]);
      let decision: unknown;
      expect(() => {
        decision = can(
          actor as never,
          action as never,
          resource as never,
          { workspaceRole, sessionRole } as never,
        );
      }).not.toThrow();
      expect(
        (decision as { allow: boolean }).allow,
        JSON.stringify({ action, workspaceRole, sessionRole, broken }),
      ).toBe(false);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(900);
  });

  it('survives hostile inputs: a resource whose every field throws, a null context', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    // A read needs no resource field: allowed, without touching it.
    expect(can(user(), 'workspace.read', hostile as never, { workspaceRole: 'owner' })).toEqual({
      allow: true,
    });
    // Decisions that read the resource are denied, not thrown.
    expect(can(user(), 'member.remove', hostile as never, { workspaceRole: 'owner' })).toEqual({
      allow: false,
      reason: 'error',
    });
    const apiKey = {
      kind: 'api_key',
      keyId: 'key_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      workspaceId: WORKSPACE,
      scopes: ['workspaces:read'],
    } as const;
    expect(can(apiKey, 'workspace.read', hostile as never)).toEqual({
      allow: false,
      reason: 'error',
    });
    expect(can(user(), 'workspace.read', { workspaceId: WORKSPACE }, null as never)).toEqual({
      allow: false,
      reason: 'not_a_member',
    });
  });
});
