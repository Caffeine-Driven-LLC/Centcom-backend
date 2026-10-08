/**
 * Settings bodies (B034, card test workspace-settings.validation.test.ts): the enum (acceptance
 * 3), the retention override against the plan's `history_days` from CT-ENTITLEMENTS' fixtures
 * and `null` clearing it (acceptance 4), unknown fields ignored and never stored (acceptance 3),
 * an entitlements outage (503 for the override only), and a property test over random bodies.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTO_APPROVE_LEVELS,
  INVALID_SETTINGS_DETAIL,
  MAX_RETENTION_DAYS,
  SETTINGS_DETAILS,
} from '../../../src/modules/workspace-settings/index.js';
import { asUser, createWorkspace } from '../workspaces/helpers.js';
import { fixtureHistoryDays, settingsApp } from './helpers.js';

const json = (res: { body: string }): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

async function setup(plan: 'free' | 'pro' | 'team' = 'pro') {
  const t = await settingsApp({ plan });
  const owner = t.store.addUser();
  const { id } = await createWorkspace(t.app, owner);
  let etag = '"s0"';
  const patch = async (payload: unknown, contentType = 'application/json') => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${id}/settings`,
      headers: { ...asUser(owner), 'if-match': etag, 'content-type': contentType },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
    if (res.statusCode === 200) etag = String(res.headers['etag']);
    return res;
  };
  const stored = () => (t.settingsStore as unknown as { rows: Map<string, unknown> }).rows.get(id);
  return { t, id, owner, patch, stored };
}

const pointers = (res: { body: string }): string[] =>
  ((json(res)['errors'] as { pointer: string }[] | undefined) ?? []).map((e) => e.pointer);

describe('auto_approve (acceptance 3)', () => {
  it("refuses 'always' with a 422 pointing at /auto_approve, without echoing it", async () => {
    const { patch, stored } = await setup();
    const res = await patch({ auto_approve: 'always' });
    expect(res.statusCode).toBe(422);
    const body = json(res);
    expect(body).toMatchObject({ code: 'validation_failed', detail: INVALID_SETTINGS_DETAIL });
    expect(pointers(res)[0]).toBe('/auto_approve');
    expect(res.body).not.toContain('always');
    expect(stored()).toBeUndefined();
  });

  it('accepts exactly ask, trusted and everyone (CT-WS-QUEUE rule 3)', async () => {
    expect(AUTO_APPROVE_LEVELS).toEqual(['ask', 'trusted', 'everyone']);
    const { patch } = await setup();
    for (const level of ['trusted', 'everyone', 'ask']) {
      const res = await patch({ auto_approve: level });
      expect(res.statusCode).toBe(200);
      expect(json(res)['auto_approve']).toBe(level);
    }
    for (const level of ['Ask', 'ASK', ' ask', '', 'never', 'none', null, 1, true, ['ask']]) {
      const res = await patch({ auto_approve: level });
      expect(res.statusCode).toBe(422);
      expect(pointers(res)).toEqual(['/auto_approve']);
    }
  });
});

describe('the other fields and the body', () => {
  it('refuses a share_history that is not a boolean', async () => {
    const { patch } = await setup();
    for (const value of ['true', 0, 1, null, {}]) {
      const res = await patch({ share_history: value });
      expect(res.statusCode).toBe(422);
      expect(pointers(res)).toEqual(['/share_history']);
    }
  });

  it('refuses a history_retention_days that is not null or whole days from 0', async () => {
    const { patch } = await setup('team');
    for (const value of [-1, 1.5, '7', true, MAX_RETENTION_DAYS + 1, 1e300]) {
      const res = await patch({ history_retention_days: value });
      expect(res.statusCode).toBe(422);
      expect(pointers(res)).toEqual(['/history_retention_days']);
    }
  });

  it('points at every bad field at once', async () => {
    const { patch } = await setup();
    const res = await patch({ auto_approve: 'x', share_history: 'x', history_retention_days: 'x' });
    expect(res.statusCode).toBe(422);
    expect(pointers(res)).toEqual(['/auto_approve', '/share_history', '/history_retention_days']);
  });

  it('ignores unknown fields and never stores them (acceptance 3)', async () => {
    const { t, id, owner, patch, stored } = await setup();
    const res = await patch({
      share_history: false,
      colour: 'red',
      version: 99,
      workspace_id: 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      retention_days: 1,
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({
      auto_approve: 'ask',
      share_history: false,
      history_retention_days: null,
    });
    expect(stored()).toEqual({
      autoApprove: 'ask',
      shareHistory: false,
      retentionDays: null,
      version: 1,
    });
    const got = await t.app.inject({
      url: `/v1/workspaces/${id}/settings`,
      headers: asUser(owner),
    });
    expect(Object.keys(json(got)).sort()).toEqual([
      'auto_approve',
      'history_retention_days',
      'share_history',
    ]);
  });

  it('refuses a body that names no setting, or is not an object', async () => {
    const { patch } = await setup();
    for (const body of [{}, { colour: 'red' }, [], ['share_history'], 'null', '"x"', '1']) {
      const res = await patch(body);
      expect(res.statusCode).toBe(422);
      expect(json(res)['code']).toBe('validation_failed');
    }
  });
});

describe('history_retention_days against the plan (acceptance 4)', () => {
  it('reads history_days from the entitlement fixtures: free 0, pro 7, team 30', () => {
    expect([
      fixtureHistoryDays('free'),
      fixtureHistoryDays('pro'),
      fixtureHistoryDays('team'),
    ]).toEqual([0, 7, 30]);
  });

  it("refuses more days than the plan's history_days with a 422, accepts up to it", async () => {
    const { t, id, patch, stored } = await setup('pro');
    const over = await patch({ history_retention_days: 8 });
    expect(over.statusCode).toBe(422);
    expect(json(over)['errors']).toEqual([
      {
        pointer: '/history_retention_days',
        code: 'out_of_range',
        detail: SETTINGS_DETAILS.overCap,
      },
    ]);
    expect(stored()).toBeUndefined();
    expect(t.entitlements.asked).toEqual([id]);
    for (const days of [7, 0, 3]) {
      const res = await patch({ history_retention_days: days });
      expect(res.statusCode).toBe(200);
      expect(json(res)['history_retention_days']).toBe(days);
    }
    t.entitlements.plan = 'team';
    expect((await patch({ history_retention_days: 30 })).statusCode).toBe(200);
    expect((await patch({ history_retention_days: 31 })).statusCode).toBe(422);
    t.entitlements.plan = 'free';
    expect((await patch({ history_retention_days: 1 })).statusCode).toBe(422);
    expect((await patch({ history_retention_days: 0 })).statusCode).toBe(200);
  });

  it('clears the override with null, without asking for entitlements', async () => {
    const { t, patch, stored } = await setup('pro');
    expect((await patch({ history_retention_days: 5 })).statusCode).toBe(200);
    const asked = t.entitlements.asked.length;
    const cleared = await patch({ history_retention_days: null });
    expect(cleared.statusCode).toBe(200);
    expect(json(cleared)['history_retention_days']).toBeNull();
    expect(stored()).toMatchObject({ retentionDays: null, version: 2 });
    expect(t.entitlements.asked).toHaveLength(asked);
  });

  it('answers 503 for an override while entitlements are down; other fields still work', async () => {
    const { t, patch, stored } = await setup('pro');
    t.entitlements.fail = true;
    const res = await patch({ history_retention_days: 3, share_history: false });
    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: 1,
      detail: SETTINGS_DETAILS.entitlements,
    });
    expect(stored()).toBeUndefined();
    expect((await patch({ share_history: false })).statusCode).toBe(200);
    expect(
      (await patch({ history_retention_days: null, auto_approve: 'trusted' })).statusCode,
    ).toBe(200);
    expect(stored()).toMatchObject({ shareHistory: false, autoApprove: 'trusted', version: 2 });
  });

  it('treats an unusable history_days as an outage, never as no limit', async () => {
    const { t, patch } = await setup('pro');
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      t.entitlements.historyDays = () => Promise.resolve(bad);
      expect((await patch({ history_retention_days: 1 })).statusCode).toBe(503);
    }
  });
});

describe('random bodies (property test)', () => {
  it('answers 200 with exactly the valid fields applied, or 422 naming only known fields', async () => {
    const { t, id, owner, stored } = await setup('team');
    const cap = fixtureHistoryDays('team');
    const value = fc.oneof(
      fc.constantFrom('ask', 'trusted', 'everyone', 'always', ''),
      fc.boolean(),
      fc.integer({ min: -5, max: 40 }),
      fc.double(),
      fc.constant(null),
      fc.string(),
    );
    const body = fc.dictionary(
      fc.constantFrom('auto_approve', 'share_history', 'history_retention_days', 'colour', 'v'),
      value,
    );
    await fc.assert(
      fc.asyncProperty(body, async (input) => {
        const before = await t.app.inject({
          url: `/v1/workspaces/${id}/settings`,
          headers: asUser(owner),
        });
        const res = await t.app.inject({
          method: 'PATCH',
          url: `/v1/workspaces/${id}/settings`,
          headers: { ...asUser(owner), 'if-match': String(before.headers['etag']) },
          payload: input,
        });
        const level = input['auto_approve'];
        const share = input['share_history'];
        const days = input['history_retention_days'];
        const valid =
          (level === undefined ||
            (typeof level === 'string' && ['ask', 'trusted', 'everyone'].includes(level))) &&
          (share === undefined || typeof share === 'boolean') &&
          (days === undefined ||
            days === null ||
            (typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= cap)) &&
          (level !== undefined || share !== undefined || days !== undefined);
        if (!valid) {
          expect(res.statusCode).toBe(422);
          for (const pointer of pointers(res)) {
            expect(['', '/auto_approve', '/share_history', '/history_retention_days']).toContain(
              pointer,
            );
          }
          expect(
            json(
              await t.app.inject({ url: `/v1/workspaces/${id}/settings`, headers: asUser(owner) }),
            ),
          ).toEqual(json(before));
          return;
        }
        expect(res.statusCode).toBe(200);
        const expected = { ...json(before) };
        if (level !== undefined) expected['auto_approve'] = level;
        if (share !== undefined) expected['share_history'] = share;
        if (days !== undefined) expected['history_retention_days'] = days;
        expect(json(res)).toEqual(expected);
        expect(Object.keys(stored() ?? {}).sort()).toEqual(
          stored() === undefined ? [] : ['autoApprove', 'retentionDays', 'shareHistory', 'version'],
        );
      }),
      { numRuns: 300, seed: 0x0b034 },
    );
  });
});
