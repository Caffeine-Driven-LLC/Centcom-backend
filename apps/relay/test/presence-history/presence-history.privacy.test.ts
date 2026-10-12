/**
 * B067 privacy (acceptance 5; guardrail: never a presence payload, CT-WS-PRESENCE "never stored
 * durably"): the two tables have exactly the allowed columns (read from Postgres), so no status,
 * activity, cursor, path or name column can appear; the recorder's events carry connection facts
 * only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';
import { pgEnv } from './helpers.js';

const ALLOWED: Record<string, string[]> = {
  presence_log: ['at', 'device_id', 'event', 'id', 'member_id', 'reason', 'session_id'],
  member_last_seen: ['connected', 'device_id', 'last_seen_at', 'member_id', 'session_id'],
};
const FORBIDDEN = /status|activity|cursor|path|name|typing|text/;

describe.runIf(STACK)('presence history schema (acceptance 5)', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it.each(Object.keys(ALLOWED))('%s has only the allowed columns', async (table) => {
    const env = await pgEnv(stack);
    const cols = (await env.db
      .selectFrom('information_schema.columns' as never)
      .select(['column_name' as never])
      .where('table_name' as never, '=', table as never)
      .execute()) as unknown as { column_name: string }[];
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(ALLOWED[table]);
    for (const name of names) expect(name).not.toMatch(FORBIDDEN);
  });
});
