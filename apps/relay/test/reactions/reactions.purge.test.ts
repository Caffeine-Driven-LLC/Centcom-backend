/**
 * B062 purge (acceptance 7): `ReactionStore.purge(sid)` and `CommentIndex.purge(sid)` remove all
 * of a session's rows (B055's history purge calls them, through `ctx.reactions.purge`), and leave
 * other sessions' rows alone.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { pgEnv } from './helpers.js';

describe.runIf(STACK)('purge on Postgres 16 (acceptance 7)', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it("removes every row of the session, and none of another's", async () => {
    const [env, other] = [await pgEnv(stack), await pgEnv(stack)];
    for (const e of [env, other]) {
      for (let seq = 1; seq <= 3; seq++) {
        await e.reactions.apply(e.sid, {
          seq,
          from: newId('mem'),
          target: newId('msg'),
          code: 'thumbs',
          op: seq === 3 ? 'remove' : 'add',
        });
        await e.comments.record(e.sid, {
          seq: 10 + seq,
          id: newId('msg'),
          from: newId('mem'),
          size: 50,
          kid: 'k1',
        });
      }
    }
    expect(await env.reactions.purge(env.sid)).toBe(3);
    expect(await env.comments.purge(env.sid)).toBe(3);
    const count = async (table: 'reaction' | 'comment_ref', sid: string) =>
      Number(
        (
          await env.db
            .selectFrom(table)
            .select(env.db.fn.countAll<string>().as('n'))
            .where('session_id', '=', sid)
            .executeTakeFirstOrThrow()
        ).n,
      );
    expect(await count('reaction', env.sid)).toBe(0);
    expect(await count('comment_ref', env.sid)).toBe(0);
    expect(await count('reaction', other.sid)).toBe(3);
    expect(await count('comment_ref', other.sid)).toBe(3);
  });
});
