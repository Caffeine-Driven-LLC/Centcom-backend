/**
 * B062 aggregates on Postgres 16 (acceptance 2; scope_in: the join flow's read): 50 targets with 6
 * codes and 20 members (6 000 live reactions, plus removed ones that do not count) give the right
 * counts per target and code, in under 50 ms (the median of 5 warm reads); targets without
 * reactions are left out, and another session's reactions never count.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REACTION_CODES, type ReactionOp } from '../../src/reactions/ports.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { pgEnv } from './helpers.js';

describe.runIf(STACK)('aggregates on Postgres 16 (acceptance 2)', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('counts 50 targets x 6 codes x 20 members correctly, in under 50 ms', async () => {
    const env = await pgEnv(stack);
    const targets = Array.from({ length: 50 }, () => newId('msg'));
    const members = Array.from({ length: 20 }, () => newId('mem'));
    let seq = 0;
    const rows: ReactionOp[] = [];
    for (const target of targets) {
      for (const code of REACTION_CODES) {
        for (const member of members)
          rows.push({ seq: ++seq, from: member, target, code, op: 'add' });
      }
    }
    // Bulk load (the apply path is tested in reactions.apply.test.ts).
    for (let i = 0; i < rows.length; i += 1_000) {
      await env.db
        .insertInto('reaction')
        .values(
          rows.slice(i, i + 1_000).map((r) => ({
            session_id: env.sid,
            target: r.target,
            code: r.code,
            member_id: r.from,
            seq: r.seq,
            removed: false,
          })),
        )
        .execute();
    }
    // Each member removed their heart on the first target: 0 hearts there.
    const first = targets[0] as string;
    for (const member of members) {
      await env.reactions.apply(env.sid, {
        seq: ++seq,
        from: member,
        target: first,
        code: 'heart',
        op: 'remove',
      });
    }
    // Another session's reactions never count.
    const other = await pgEnv(stack);
    await other.reactions.apply(other.sid, {
      seq: 1,
      from: newId('mem'),
      target: first,
      code: 'eyes',
      op: 'add',
    });

    const asked = [...targets, newId('msg')];
    const counts = await env.reactions.aggregate(env.sid, asked);
    expect(Object.keys(counts).sort()).toEqual([...targets].sort());
    for (const target of targets) {
      const expected = Object.fromEntries(REACTION_CODES.map((c) => [c, 20]));
      if (target === first) delete expected['heart'];
      expect(counts[target], target).toEqual(expected);
    }

    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await env.reactions.aggregate(env.sid, targets);
      times.push(performance.now() - start);
    }
    times.sort((x, y) => x - y);
    expect(times[2]).toBeLessThan(50);
  }, 120_000);
});
