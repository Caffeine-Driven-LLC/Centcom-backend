/**
 * B062 comment pointers (acceptance 5, 6; guardrail: never store or log comment text or `ct`):
 * `comment_ref` has no text column (the schema, read from Postgres: only pointer columns);
 * recording a comment twice (a replayed frame) leaves one row; the stage records a sequenced
 * comment's seq, frame id, sender, `ct` size and key id only, and refuses a `comment.add` with a
 * cleartext `p` or no `ct`. The relay cannot cap comments per target: the target is inside `ct`
 * (CT-WS-SESSION-EVENTS catalogue, comment.add), declared in the PR.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { comment, pgEnv, stageEnv } from './helpers.js';

describe.runIf(STACK)('comment_ref on Postgres 16 (acceptance 5, 6)', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('has only pointer columns, no text', async () => {
    const env = await pgEnv(stack);
    const cols = await env.db
      .selectFrom('information_schema.columns' as never)
      .select(['column_name' as never])
      .where('table_name' as never, '=', 'comment_ref' as never)
      .execute();
    expect((cols as unknown as { column_name: string }[]).map((c) => c.column_name).sort()).toEqual(
      ['created_at', 'kid', 'member_id', 'msg_id', 'seq', 'session_id', 'size'],
    );
  });

  it('a replayed frame lands on one row', async () => {
    const env = await pgEnv(stack);
    const c = { seq: 5, id: newId('msg'), from: newId('mem'), size: 120, kid: 'k1' };
    await env.comments.record(env.sid, c);
    await env.comments.record(env.sid, c);
    const rows = await env.db
      .selectFrom('comment_ref')
      .selectAll()
      .where('session_id', '=', env.sid)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('the comment stage', () => {
  it('records pointers only, and refuses a p or a missing ct', async () => {
    const env = stageEnv();
    const me = env.member();
    const frame = comment({
      ct: { alg: 'xchacha20poly1305', kid: 'k7', n: 'N'.repeat(32), c: 'SECRET-COMMENT' },
    });
    expect((await env.send(frame, me)).passed).toBe(true);
    expect(env.recorded).toEqual([
      {
        sid: env.sid,
        c: {
          seq: 1,
          id: frame['id'],
          from: me,
          size: Buffer.byteLength(JSON.stringify(frame['ct']), 'utf8'),
          kid: 'k7',
        },
      },
    ]);
    expect(JSON.stringify(env.recorded)).not.toContain('SECRET-COMMENT');
    for (const bad of [comment({ p: { target: newId('msg') } }), comment({ ct: undefined })]) {
      const out = await env.send(bad, me);
      expect(out.passed).toBe(false);
      expect(out.error).toMatchObject({ ref: bad['id'], p: { code: 'invalid_frame' } });
    }
    expect(env.captured.raw()).not.toContain('SECRET-COMMENT');
  });
});
