/**
 * The contract (B074 test plan "schema validation and error shape (CT-ERR)"): a valid batch is a
 * valid `api/UsageBatch`, the answer a valid `api/UsageBatchResult` with only `accepted` and
 * `duplicates`; a refused batch is a CT-ERR problem (`problem` schema, `application/problem+json`)
 * whose `errors[]` carry pointers and codes; a 403 and a 429 are problems too.
 */
import { validate, validateProblem } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { newId, usageApp, usageEvent, usageEvents } from './helpers.js';

describe('usage contract', () => {
  it('takes a UsageBatch and answers a UsageBatchResult', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const payload = { events: usageEvents(3) };
    expect(validate('api/UsageBatch', payload).ok).toBe(true);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: d.headers(),
      payload,
    });
    expect(validate('api/UsageBatchResult', response.json()).ok).toBe(true);
    expect(Object.keys(response.json<object>()).sort()).toEqual(['accepted', 'duplicates']);
    await ctx.app.close();
  });

  it('refuses with CT-ERR problems', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: d.headers(),
      payload: { events: [usageEvent({ qty: -1, type: 'nope' })] },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.headers['content-type']).toContain('application/problem+json');
    expect(validateProblem(invalid.json()).ok).toBe(true);
    expect(invalid.json<{ errors: { pointer: string; code: string }[] }>().errors).toEqual([
      expect.objectContaining({ pointer: '/events/0/type', code: 'invalid_value' }),
      expect.objectContaining({ pointer: '/events/0/qty', code: 'out_of_range' }),
    ]);
    const session = newId('ses');
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: d.headers(),
      payload: { events: [usageEvent({ session_id: session })] },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(validateProblem(forbidden.json()).ok).toBe(true);
    await ctx.app.close();
  });
});
