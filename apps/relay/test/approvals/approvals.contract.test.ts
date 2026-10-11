/**
 * B060 contract (CT-WS-SESSION-EVENTS `approval.request` / `approval.decision`): both fixtures
 * validate against the event schemas; the fixture request is accepted once its expiry is moved
 * into the future (the fixture's `expires_at` equals its `ts`, which is in the past); the fixture
 * decision decides it (sent with its own frame id: both fixtures carry the same one, which the
 * sequencer would take for a resend); the server's timeout deny validates as an `approval.decision`.
 */
import { newId, validateEvent } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { approvalEnv, fixture, inTenMinutes } from './helpers.js';

describe('approval contract', () => {
  it('the fixtures validate, and route once the expiry is in the future', async () => {
    const req = fixture('approval.request');
    const dec = fixture('approval.decision');
    expect(validateEvent('approval.request', req['p']).ok).toBe(true);
    expect(validateEvent('approval.decision', dec['p']).ok).toBe(true);
    const env = approvalEnv();
    const p = req['p'] as Record<string, unknown>;
    env.agents.set(String(p['agent_id']), env.editor.memberId);
    // As written (expires_at = ts, long past): invalid_frame.
    expect(await env.request({ id: String(req['id']), p }, env.host)).toMatchObject({
      code: 'invalid_frame',
    });
    const future = { ...p, expires_at: new Date(inTenMinutes(env.clock.now)).toISOString() };
    expect(await env.request({ id: String(req['id']), p: future }, env.host)).toEqual({
      outcome: 'sequenced',
    });
    expect(await env.decide({ id: newId('msg'), p: dec['p'] }, env.host)).toEqual({
      outcome: 'sequenced',
    });
  });

  it('the timeout deny validates as an approval.decision', () => {
    const p = { approval_id: 'apr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', decision: 'deny', scope: 'once' };
    expect(validateEvent('approval.decision', p).ok).toBe(true);
  });
});
