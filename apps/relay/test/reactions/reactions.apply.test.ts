/**
 * B062 reaction state on Postgres 16 (acceptance 1, 6; guardrails: state from sequenced frames
 * only, nobody removes another member's reaction): add twice is one row; remove drops it from the
 * live set; a remove of a missing reaction is a no-op (`changed` false); replaying a frame (same
 * seq) changes nothing; frames applied out of order end in the state of the highest seq; a remove
 * touches only its sender's reaction; rebuilding from the log reproduces the state.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReactionOp } from '../../src/reactions/ports.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { pgEnv } from './helpers.js';

describe.runIf(STACK)('reaction state on Postgres 16 (acceptance 1, 6)', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  const rows = async (env: Awaited<ReturnType<typeof pgEnv>>) =>
    env.db
      .selectFrom('reaction')
      .select(['target', 'code', 'member_id', 'seq', 'removed'])
      .where('session_id', '=', env.sid)
      .execute();

  it('add twice is one row; remove drops it; a missing remove is a no-op', async () => {
    const env = await pgEnv(stack);
    const [target, me] = [newId('msg'), newId('mem')];
    const op = (seq: number, o: 'add' | 'remove'): ReactionOp => ({
      seq,
      from: me,
      target,
      code: 'heart',
      op: o,
    });
    expect(await env.reactions.apply(env.sid, op(1, 'add'))).toEqual({ changed: true });
    expect(await env.reactions.apply(env.sid, op(2, 'add'))).toEqual({ changed: false });
    expect(await rows(env)).toHaveLength(1);
    expect(await env.reactions.aggregate(env.sid, [target])).toEqual({ [target]: { heart: 1 } });
    expect(await env.reactions.apply(env.sid, op(3, 'remove'))).toEqual({ changed: true });
    expect(await env.reactions.aggregate(env.sid, [target])).toEqual({});
    // A remove of a reaction never added: nothing live changes.
    const other = newId('msg');
    expect(await env.reactions.apply(env.sid, { ...op(4, 'remove'), target: other })).toEqual({
      changed: false,
    });
    expect(await env.reactions.aggregate(env.sid, [target, other])).toEqual({});
  });

  it('concurrent first writes for one key: the highest seq wins, and changed is right', async () => {
    const env = await pgEnv(stack);
    const base = { from: newId('mem'), target: newId('msg'), code: 'heart' as const };
    const results = await Promise.all([
      env.reactions.apply(env.sid, { ...base, seq: 5, op: 'add' }),
      env.reactions.apply(env.sid, { ...base, seq: 6, op: 'remove' }),
    ]);
    expect(await env.reactions.aggregate(env.sid, [base.target])).toEqual({});
    // Either order: the add makes it live (changed) and the remove takes it out (changed), or
    // the remove lands first (a no-op) and the older add is ignored (no change).
    const changed = results.map((r) => r.changed);
    expect([
      [true, true],
      [false, false],
    ]).toContainEqual(changed);
  });

  it('a replayed frame (same seq) changes nothing', async () => {
    const env = await pgEnv(stack);
    const op: ReactionOp = {
      seq: 7,
      from: newId('mem'),
      target: newId('msg'),
      code: 'eyes',
      op: 'add',
    };
    await env.reactions.apply(env.sid, op);
    expect(await env.reactions.apply(env.sid, op)).toEqual({ changed: false });
    expect(await rows(env)).toEqual([expect.objectContaining({ seq: '7', removed: false })]);
  });

  it('frames applied out of order end in the state of the highest seq', async () => {
    const env = await pgEnv(stack);
    const base = { from: newId('mem'), target: newId('msg'), code: 'party' as const };
    await env.reactions.apply(env.sid, { ...base, seq: 11, op: 'remove' });
    // The older add arrives late: the remove after it wins.
    expect(await env.reactions.apply(env.sid, { ...base, seq: 10, op: 'add' })).toEqual({
      changed: false,
    });
    expect(await env.reactions.aggregate(env.sid, [base.target])).toEqual({});
    await env.reactions.apply(env.sid, { ...base, seq: 12, op: 'add' });
    expect(await env.reactions.aggregate(env.sid, [base.target])).toEqual({
      [base.target]: { party: 1 },
    });
  });

  it("a remove touches only its sender's reaction", async () => {
    const env = await pgEnv(stack);
    const target = newId('msg');
    const [a, b] = [newId('mem'), newId('mem')];
    await env.reactions.apply(env.sid, { seq: 1, from: a, target, code: 'check', op: 'add' });
    await env.reactions.apply(env.sid, { seq: 2, from: b, target, code: 'check', op: 'remove' });
    expect(await env.reactions.aggregate(env.sid, [target])).toEqual({ [target]: { check: 1 } });
  });

  it('rebuilding from the log reproduces the state (the repair after failed writes)', async () => {
    const env = await pgEnv(stack);
    const target = newId('msg');
    const [a, b] = [newId('mem'), newId('mem')];
    const log: ReactionOp[] = [
      { seq: 1, from: a, target, code: 'thumbs', op: 'add' },
      { seq: 2, from: b, target, code: 'thumbs', op: 'add' },
      { seq: 3, from: a, target, code: 'thumbs', op: 'remove' },
      { seq: 4, from: a, target, code: 'laugh', op: 'add' },
    ];
    // Only the first write made it before the database failed.
    await env.reactions.apply(env.sid, log[0] as ReactionOp);
    expect(await env.reactions.rebuild(env.sid, log)).toBe(4);
    expect(await env.reactions.rebuild(env.sid, log)).toBe(4);
    expect(await env.reactions.aggregate(env.sid, [target])).toEqual({
      [target]: { thumbs: 1, laugh: 1 },
    });
  });
});
