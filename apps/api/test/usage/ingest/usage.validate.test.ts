/**
 * Validation (B074 acceptance 2 and 4, guardrails "reject the whole batch", "validate qty and at
 * server-side"): every field rule, per-type caps at their edges, the time window (31 days back,
 * 60 s ahead of the server clock), ids once per batch; one bad event fails the whole batch with
 * 422, each problem at its pointer with an `out_of_range`-style code, and stores nothing; 501
 * events are 422, a body over 1 MiB is 413.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_BYTES,
  parseUsageBatch,
  USAGE_QTY_CAPS,
  USAGE_TYPES,
} from '../../../src/modules/usage/validate.js';
import { newId, T0, usageApp, usageEvent, usageEvents } from './helpers.js';

type Problem = { code: string; errors?: { pointer: string; code: string }[] };
const NOW = new Date(T0);

function problemOf(body: unknown): Problem {
  try {
    parseUsageBatch(body, NOW);
  } catch (err) {
    return err as Problem;
  }
  throw new Error('no problem');
}

describe('parseUsageBatch', () => {
  it('accepts every type up to its cap, and optional session and agent ids', () => {
    const events = USAGE_TYPES.map((type) =>
      usageEvent({
        type,
        qty: USAGE_QTY_CAPS[type],
        session_id: newId('ses'),
        agent_id: newId('agt'),
      }),
    );
    const parsed = parseUsageBatch({ events, extra: 'ignored' }, NOW);
    expect(parsed.map((e) => [e.type, e.qty])).toEqual(
      USAGE_TYPES.map((t) => [t, USAGE_QTY_CAPS[t]]),
    );
    expect(parsed[0]).not.toHaveProperty('extra');
    expect(parseUsageBatch({ events: [usageEvent({ qty: 0 })] }, NOW)[0]?.qty).toBe(0);
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ['qty -1', { qty: -1 }, '/qty', 'out_of_range'],
    ['a fractional qty', { qty: 1.5 }, '/qty', 'invalid_type'],
    ['a qty in a string', { qty: '12' }, '/qty', 'invalid_type'],
    ['a qty over the cap', { type: 'agent_minutes', qty: 1441 }, '/qty', 'out_of_range'],
    ['an unknown type', { type: 'gpu_seconds' }, '/type', 'invalid_value'],
    ['at 2 minutes ahead', { at: new Date(T0 + 120_000).toISOString() }, '/at', 'out_of_range'],
    [
      'at 32 days back',
      { at: new Date(T0 - 32 * 86_400_000).toISOString() },
      '/at',
      'out_of_range',
    ],
    ['at without a zone', { at: '2026-10-07T11:59:00' }, '/at', 'invalid_format'],
    ['an id without its prefix', { id: '01JA3Z8K2M5N7P9Q0R1S2T3V4W' }, '/id', 'invalid_format'],
    ['a malformed session id', { session_id: 'ses_nope' }, '/session_id', 'invalid_format'],
    ['a malformed agent id', { agent_id: 42 }, '/agent_id', 'invalid_format'],
  ])('refuses %s at /events/<i>%s', (_case, change, field, code) => {
    const events = [usageEvent(), usageEvent(), usageEvent(change)];
    const problem = problemOf({ events });
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors).toEqual([
      expect.objectContaining({ pointer: `/events/2${field}`, code }),
    ]);
  });

  it('accepts the window edges: 60 s ahead and 31 days back', () => {
    const edges = [
      usageEvent({ at: new Date(T0 + 60_000).toISOString() }),
      usageEvent({ at: new Date(T0 - 31 * 86_400_000).toISOString() }),
    ];
    expect(parseUsageBatch({ events: edges }, NOW)).toHaveLength(2);
  });

  it('refuses an id twice in one batch, and lists every problem', () => {
    const twice = usageEvent();
    const problem = problemOf({
      events: [twice, { ...twice }, usageEvent({ qty: -2, type: 'x' })],
    });
    expect(problem.errors?.map((e) => e.pointer)).toEqual([
      '/events/1/id',
      '/events/2/type',
      '/events/2/qty',
    ]);
  });

  it('refuses 0 or 501 events, a missing array and a body that is not an object', () => {
    expect(problemOf({ events: [] }).errors?.[0]?.pointer).toBe('/events');
    expect(problemOf({ events: usageEvents(501) }).errors?.[0]).toMatchObject({
      pointer: '/events',
      code: 'out_of_range',
    });
    expect(problemOf({}).errors?.[0]?.pointer).toBe('/events');
    expect(problemOf([]).errors?.[0]?.pointer).toBe('');
    expect(parseUsageBatch({ events: usageEvents(500) }, NOW)).toHaveLength(500);
  });
});

describe('POST /v1/usage/events validation', () => {
  it('answers 422 for a batch with one bad event, and stores nothing from it', async () => {
    const { app, device, memory } = await usageApp();
    const d = await device();
    memory.personal(d.userId);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: d.headers(),
      payload: { events: [...usageEvents(10), usageEvent({ qty: -1 })] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<Problem>().errors?.[0]).toMatchObject({
      pointer: '/events/10/qty',
      code: 'out_of_range',
    });
    expect(memory.rows.size).toBe(0);
    await app.close();
  });

  it('answers 422 for 501 events and 413 for a body over 1 MiB', async () => {
    const { app, device, memory } = await usageApp();
    const d = await device();
    memory.personal(d.userId);
    const tooMany = await app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: d.headers(),
      payload: { events: usageEvents(501) },
    });
    expect(tooMany.statusCode).toBe(422);
    const big = JSON.stringify({ events: usageEvents(1), padding: 'x'.repeat(MAX_BATCH_BYTES) });
    const tooBig = await app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: { ...d.headers(), 'content-type': 'application/json' },
      payload: big,
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json<Problem>().code).toBe('payload_too_large');
    expect(memory.rows.size).toBe(0);
    await app.close();
  });
});
