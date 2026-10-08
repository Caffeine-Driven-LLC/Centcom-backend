/**
 * The audit API's routes (B082) on the API's plugin stack, over the in-memory repository:
 *
 * - authorisation matrix: owners and admins (and API keys with `audit:read`) in; members, guests
 *   and billing members 403 `forbidden`; non-members, other workspaces' keys and unknown
 *   workspaces 404; a credential without `audit:read` 403; on all three routes;
 * - the plan: `audit_log_days = 0` refuses the list and new exports with 403 `entitlement_required`
 *   (a member still gets `forbidden` first); with 90 days, day 91 is hidden though stored;
 * - filters ANDed, an unknown action an empty page, `from` after `to` 422 at `/from`;
 * - pagination over 10 000 events, 200 a page, while events keep arriving: each event once, in
 *   order; a cursor expires after 24 h and is refused for other filters or another workspace;
 * - exports: 202 with Location, the same Idempotency-Key the same export, an `audit.export` event
 *   (reads write none), more than the cap 422 at `/from`, a failed enqueue still accepted;
 * - contract: pages are CT-PAGE `AuditEventPage`s, exports `AuditExport`s in every status, and
 *   errors problem+json.
 */
import { randomUUID } from 'node:crypto';
import { newId, validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { AUDIT_API_ACTIONS } from '../../src/modules/audit-api/actions.js';
import { AuditExportRunner } from '../../src/modules/audit-api/exporter.js';
import {
  asKey,
  asUser,
  auditApp,
  auditRow,
  DAY,
  list,
  requestExport,
  T0,
  team,
} from './helpers.js';

const READ = 'audit:read';

describe('audit API authorisation', () => {
  it('lets owners, admins and audit:read keys in, and keeps everyone else out', async () => {
    const t = await auditApp();
    const { workspace, owner, admin, member, guest, billing } = await team(t);
    const other = await team(t);
    t.repo.add(auditRow(workspace));
    const exp = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{ id: string }>()
      .id;

    const routes = [
      { method: 'GET' as const, url: `/v1/workspaces/${workspace}/audit` },
      { method: 'POST' as const, url: `/v1/workspaces/${workspace}/audit/exports` },
      { method: 'GET' as const, url: `/v1/workspaces/${workspace}/audit/exports/${exp}` },
    ];
    const cases: [string, Record<string, string>, number, string | null][] = [
      ['owner', asUser(owner, READ), 200, null],
      ['admin', asUser(admin, READ), 200, null],
      ['key with audit:read', asKey(workspace, READ), 200, null],
      ['member', asUser(member, READ), 403, 'forbidden'],
      ['guest', asUser(guest, READ), 403, 'forbidden'],
      ['billing member', asUser(billing, READ), 403, 'forbidden'],
      ['admin without the scope', asUser(admin, 'workspaces:read'), 403, 'forbidden'],
      [
        'key without audit:read',
        asKey(workspace, 'workspaces:read webhooks:write'),
        403,
        'forbidden',
      ],
      ['non-member', asUser(newId('usr'), READ), 404, 'not_found'],
      ["another workspace's admin", asUser(other.admin, READ), 404, 'not_found'],
      ["another workspace's key", asKey(other.workspace, READ), 404, 'not_found'],
      ['nobody', {}, 401, 'unauthorized'],
    ];
    for (const route of routes) {
      for (const [who, headers, status, code] of cases) {
        const res = await t.app.inject({
          ...route,
          headers,
          ...(route.method === 'POST' ? { payload: { format: 'json' } } : {}),
        });
        const expected = status === 200 && route.method === 'POST' ? 202 : status;
        expect(res.statusCode, `${who} ${route.method} ${route.url}`).toBe(expected);
        if (code !== null) {
          expect(res.json<{ code: string }>().code, who).toBe(code);
          expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
        }
      }
    }

    // An unknown workspace, and another workspace's export id, are 404 like a stranger's.
    const unknown = await list(t.app, newId('wsp'), asUser(owner, READ));
    expect(unknown.statusCode).toBe(404);
    const foreign = await t.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${other.workspace}/audit/exports/${exp}`,
      headers: asUser(other.owner, READ),
    });
    expect(foreign.statusCode).toBe(404);
    await t.app.close();
  });

  it('audits refusals of members (CT-RBAC rule 6) but never a read', async () => {
    const t = await auditApp();
    const { workspace, owner, member } = await team(t);
    t.repo.add(auditRow(workspace));
    for (let i = 0; i < 3; i += 1) {
      expect((await list(t.app, workspace, asUser(owner, READ))).statusCode).toBe(200);
    }
    await t.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace}/audit/exports/${newId('exp')}`,
      headers: asUser(owner, READ),
    });
    await t.emitter.flush(1000);
    expect(t.repo.audited).toEqual([]);
    expect(t.detached).toEqual([]);

    expect((await list(t.app, workspace, asUser(member, READ))).statusCode).toBe(403);
    await t.emitter.flush(1000);
    expect(t.detached.map((r) => r['action'])).toEqual(['permission.denied']);
    await t.app.close();
  });
});

describe('the plan', () => {
  it('refuses the list and new exports with entitlement_required when audit_log_days is 0', async () => {
    const t = await auditApp();
    const { workspace, owner, member } = await team(t);
    t.days.set(workspace, 0);
    const listed = await list(t.app, workspace, asUser(owner, READ));
    expect(listed.statusCode).toBe(403);
    expect(listed.json<{ code: string }>().code).toBe('entitlement_required');
    expect(validate('problem', listed.json()).ok).toBe(true);
    const exported = await requestExport(t.app, workspace, asUser(owner, READ));
    expect(exported.statusCode).toBe(403);
    expect(exported.json<{ code: string }>().code).toBe('entitlement_required');
    expect(t.repo.exports.size).toBe(0);
    // Below admin, the role answers first: the plan is not the member's business.
    const asMember = await list(t.app, workspace, asUser(member, READ));
    expect(asMember.json<{ code: string }>().code).toBe('forbidden');
    await t.app.close();
  });

  it('shows the last audit_log_days days only, even when older events are stored', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.days.set(workspace, 90);
    const recent = auditRow(workspace, { at: T0 - 89 * DAY });
    const edge = auditRow(workspace, { at: T0 - 90 * DAY });
    const old = auditRow(workspace, { at: T0 - 91 * DAY });
    t.repo.add(recent, edge, old);
    const ids = (q = '') =>
      list(t.app, workspace, asUser(owner, READ), q).then((r) =>
        r.json<{ data: { id: string }[] }>().data.map((e) => e.id),
      );
    expect(await ids()).toEqual([recent.id, edge.id]);
    // An explicit range does not reach past the horizon either.
    expect(await ids(`from=${new Date(T0 - 200 * DAY).toISOString()}`)).toEqual([
      recent.id,
      edge.id,
    ]);
    t.days.set(workspace, 30);
    expect(await ids()).toEqual([]);
    await t.app.close();
  });
});

describe('filters', () => {
  it('combines actor, action and the time range with AND', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    const alice = newId('usr');
    const key = newId('key');
    const rows = [
      auditRow(workspace, { actor_id: alice, action: 'member.add', at: T0 - 5 * DAY }),
      auditRow(workspace, { actor_id: alice, action: 'member.remove', at: T0 - 4 * DAY }),
      auditRow(workspace, { actor_id: alice, action: 'member.add', at: T0 - 3 * DAY }),
      auditRow(workspace, {
        actor_type: 'api_key',
        actor_id: key,
        action: 'member.add',
        at: T0 - 2 * DAY,
      }),
    ];
    t.repo.add(...rows);
    const ids = async (q: string) =>
      (await list(t.app, workspace, asUser(owner, READ), q))
        .json<{ data: { id: string }[] }>()
        .data.map((e) => e.id);
    expect(await ids(`actor=${alice}`)).toEqual([rows[2]?.id, rows[1]?.id, rows[0]?.id]);
    expect(await ids(`actor=${alice}&action=member.add`)).toEqual([rows[2]?.id, rows[0]?.id]);
    expect(await ids('action=member.add')).toEqual([rows[3]?.id, rows[2]?.id, rows[0]?.id]);
    expect(await ids(`actor=${key}`)).toEqual([rows[3]?.id]);
    const from = new Date(T0 - 4 * DAY).toISOString();
    const to = new Date(T0 - 2 * DAY).toISOString();
    // `from` inclusive, `to` exclusive.
    expect(await ids(`actor=${alice}&from=${from}&to=${to}`)).toEqual([rows[2]?.id, rows[1]?.id]);
    expect(await ids(`action=member.add&from=${from}&to=${to}`)).toEqual([rows[2]?.id]);
    await t.app.close();
  });

  it('answers an unknown action with an empty page, and bad filters with 422', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.repo.add(auditRow(workspace));
    const empty = await list(t.app, workspace, asUser(owner, READ), 'action=nothing.like_this');
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ data: [], next_cursor: null, has_more: false });

    const later = new Date(T0).toISOString();
    const earlier = new Date(T0 - DAY).toISOString();
    const reversed = await list(
      t.app,
      workspace,
      asUser(owner, READ),
      `from=${later}&to=${earlier}`,
    );
    expect(reversed.statusCode).toBe(422);
    const problem = reversed.json<{ code: string; errors: { pointer: string }[] }>();
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors.map((e) => e.pointer)).toEqual(['/from']);
    expect(validate('problem', problem).ok).toBe(true);

    for (const [q, pointer] of [
      ['actor=alice', '/actor'],
      [`actor=${newId('wsp')}`, '/actor'],
      ['from=yesterday', '/from'],
      ['to=2026-10-08', '/to'],
      [`action=${'a'.repeat(65)}`, '/action'],
      ['action=a&action=b', '/action'],
    ] as const) {
      const res = await list(t.app, workspace, asUser(owner, READ), q);
      expect(res.statusCode, q).toBe(422);
      expect(res.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer, q).toBe(pointer);
    }
    await t.app.close();
  });
});

describe('pagination', () => {
  it('returns 10 000 events exactly once, newest first, while new ones arrive', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    const seeded = Array.from({ length: 10_000 }, (_, i) =>
      // Several events share each millisecond, so ties are broken by id.
      auditRow(workspace, { at: T0 - 60_000 - Math.floor(i / 3) }),
    );
    t.repo.add(...seeded);
    const expected = [...seeded]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1))
      .map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `limit=200${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await list(t.app, workspace, asUser(owner, READ), q);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: { id: string }[]; next_cursor: string | null }>();
      seen.push(...body.data.map((e) => e.id));
      cursor = body.next_cursor;
      pages += 1;
      // New events keep arriving between pages.
      t.clock.now += 1000;
      t.repo.add(
        auditRow(workspace, { at: t.clock.now - 10 }),
        auditRow(workspace, { at: t.clock.now }),
      );
    } while (cursor !== null);
    expect(pages).toBe(50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
    await t.app.close();
  });

  it('refuses a cursor after 24 hours, and one from other filters or another workspace', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    const other = await team(t);
    const actor = newId('usr');
    for (let i = 0; i < 5; i += 1) {
      t.repo.add(auditRow(workspace, { actor_id: actor }), auditRow(other.workspace));
    }
    const first = await list(t.app, workspace, asUser(owner, READ), `limit=2&actor=${actor}`);
    const cursor = encodeURIComponent(first.json<{ next_cursor: string }>().next_cursor);

    const fine = await list(
      t.app,
      workspace,
      asUser(owner, READ),
      `limit=2&actor=${actor}&cursor=${cursor}`,
    );
    expect(fine.statusCode).toBe(200);

    for (const [headers, ws, q] of [
      [asUser(owner, READ), workspace, `limit=2&cursor=${cursor}`],
      [asUser(owner, READ), workspace, `limit=2&actor=${newId('usr')}&cursor=${cursor}`],
      [asUser(owner, READ), workspace, `limit=2&actor=${actor}&action=member.add&cursor=${cursor}`],
      [asUser(other.owner, READ), other.workspace, `limit=2&actor=${actor}&cursor=${cursor}`],
    ] as const) {
      const res = await list(t.app, ws, headers, q);
      expect(res.statusCode, q).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('cursor_invalid');
      expect(validate('problem', res.json()).ok).toBe(true);
    }

    t.clock.now = T0 + DAY + 1000;
    const expired = await list(
      t.app,
      workspace,
      asUser(owner, READ),
      `limit=2&actor=${actor}&cursor=${cursor}`,
    );
    expect(expired.statusCode).toBe(400);
    expect(expired.json<{ code: string }>().code).toBe('cursor_invalid');
    await t.app.close();
  });
});

describe('export requests', () => {
  it('accepts an export with 202 and Location, and writes its audit event', async () => {
    const t = await auditApp();
    const { workspace, admin } = await team(t);
    t.repo.add(auditRow(workspace), auditRow(workspace));
    const from = new Date(T0 - 7 * DAY).toISOString();
    const res = await requestExport(t.app, workspace, asUser(admin, READ), {
      format: 'csv',
      action: 'member.add',
      from,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ id: string; status: string; format: string; created_at: string }>();
    expect(body).toEqual({
      id: expect.stringMatching(/^exp_[0-9A-Z]{26}$/) as unknown,
      status: 'pending',
      format: 'csv',
      created_at: new Date(T0).toISOString(),
      expires_at: null,
      download_url: null,
    });
    expect(validate('api/AuditExport', body).ok).toBe(true);
    expect(res.headers['location']).toBe(`/v1/workspaces/${workspace}/audit/exports/${body.id}`);
    expect(t.exportQueue.enqueued).toEqual([body.id]);

    expect(t.repo.audited).toHaveLength(1);
    expect(t.repo.audited[0]).toMatchObject({
      workspace_id: workspace,
      actor_type: 'user',
      actor_id: admin,
      action: 'audit.export',
      target_type: 'audit_export',
      target_id: body.id,
      outcome: 'success',
      request_id: expect.stringMatching(/^req_/) as unknown,
    });
    expect(JSON.parse(String(t.repo.audited[0]?.['meta']))).toEqual({
      format: 'csv',
      gzip: false,
      filters: 'action,from',
    });
    // The export remembers its filters and horizon, and covers events up to the request.
    expect(t.repo.exports.get(body.id)).toMatchObject({
      requestedBy: admin,
      format: 'csv',
      gzip: false,
      filters: { action: 'member.add', from, since: new Date(T0 - 90 * DAY).toISOString() },
      createdAt: new Date(T0),
    });

    const status = await t.app.inject({
      method: 'GET',
      url: String(res.headers['location']),
      headers: asUser(admin, READ),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual(body);
    await t.app.close();
  });

  it('returns the same export for the same Idempotency-Key', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    const headers = { ...asUser(owner, READ), 'idempotency-key': randomUUID() };
    const first = await requestExport(t.app, workspace, headers, { format: 'json' });
    const again = await requestExport(t.app, workspace, headers, { format: 'json' });
    expect(again.statusCode).toBe(202);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(t.repo.exports.size).toBe(1);
    expect(t.repo.audited).toHaveLength(1);
    const conflict = await requestExport(t.app, workspace, headers, { format: 'csv' });
    expect(conflict.statusCode).toBe(409);
    await t.app.close();
  });

  it('refuses a range holding more than the cap with 422 at /from', async () => {
    const t = await auditApp({ maxRows: 5 });
    const { workspace, owner } = await team(t);
    for (let i = 0; i < 6; i += 1) t.repo.add(auditRow(workspace, { action: 'member.add' }));
    t.repo.add(auditRow(workspace, { action: 'member.remove' }));
    const big = await requestExport(t.app, workspace, asUser(owner, READ), { format: 'csv' });
    expect(big.statusCode).toBe(422);
    expect(big.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/from');
    expect(t.repo.exports.size).toBe(0);
    const small = await requestExport(t.app, workspace, asUser(owner, READ), {
      format: 'csv',
      action: 'member.remove',
    });
    expect(small.statusCode).toBe(202);
    await t.app.close();
  });

  it('validates the body', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    for (const [payload, pointer] of [
      [{}, '/format'],
      [{ format: 'xml' }, '/format'],
      [{ format: 'csv', gzip: 'yes' }, '/gzip'],
      [{ format: 'csv', actor: 'bob' }, '/actor'],
      [{ format: 'csv', from: '2026-10-08T00:00:00Z', to: '2026-10-01T00:00:00Z' }, '/from'],
    ] as const) {
      const res = await requestExport(t.app, workspace, asUser(owner, READ), payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(
        res.json<{ errors: { pointer: string }[] }>().errors.map((e) => e.pointer),
        JSON.stringify(payload),
      ).toContain(pointer);
    }
    const gz = await requestExport(t.app, workspace, asUser(owner, READ), {
      format: 'csv',
      gzip: true,
    });
    expect(gz.statusCode).toBe(202);
    expect(t.repo.exports.get(gz.json<{ id: string }>().id)?.gzip).toBe(true);
    await t.app.close();
  });

  it('keeps the export pending when queueing fails, for the sweep to queue it', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.exportQueue.fail = true;
    const res = await requestExport(t.app, workspace, asUser(owner, READ));
    expect(res.statusCode).toBe(202);
    const id = res.json<{ id: string }>().id;
    expect(t.repo.exports.get(id)?.status).toBe('pending');
    expect(await t.repo.stalePending(new Date(T0 + 3 * 60_000), 10)).toEqual([id]);
    await t.app.close();
  });
});

describe('contract', () => {
  it('answers CT-PAGE AuditEventPages, AuditExports in every status, and problem+json', async () => {
    const t = await auditApp();
    const { workspace, owner, member } = await team(t);
    const actors = [
      { actor_type: 'user', actor_id: newId('usr') },
      { actor_type: 'api_key', actor_id: newId('key') },
      { actor_type: 'device', actor_id: newId('dev') },
      { actor_type: 'system', actor_id: 'retention' },
    ] as const;
    const outcomes = ['success', 'denied', 'failed'] as const;
    let at = T0 - 1000;
    for (const action of Object.keys(AUDIT_API_ACTIONS)) {
      at -= 1000;
      const i = Math.floor(at / 1000);
      t.repo.add(
        auditRow(workspace, {
          at,
          action,
          ...actors[Math.abs(i) % actors.length],
          outcome: outcomes[Math.abs(i) % outcomes.length],
          ...(i % 2 === 0 ? { target_type: null, target_id: null } : {}),
        }),
      );
    }
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `limit=7${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await list(t.app, workspace, asUser(owner, READ), q);
      const page = res.json<{ next_cursor: string | null; has_more: boolean }>();
      const checked = validate('api/AuditEventPage', page);
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      expect(page.has_more).toBe(page.next_cursor !== null);
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(Math.ceil(Object.keys(AUDIT_API_ACTIONS).length / 7));

    // An export in each status.
    const runner = new AuditExportRunner({
      repository: t.repo,
      store: t.objects,
      maxRows: 1_000_000,
      retainMs: DAY,
      clock: () => t.clock.now,
    });
    const statusOf = async (id: string) => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspace}/audit/exports/${id}`,
        headers: asUser(owner, READ),
      });
      const checked = validate('api/AuditExport', res.json());
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      return res.json<{ status: string }>().status;
    };
    const pending = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{
      id: string;
    }>().id;
    expect(await statusOf(pending)).toBe('pending');
    await runner.run(pending, { finalAttempt: false });
    expect(await statusOf(pending)).toBe('ready');
    const failing = (
      await requestExport(t.app, workspace, asUser(owner, READ), { format: 'json' })
    ).json<{ id: string }>().id;
    t.objects.down = true;
    await runner.run(failing, { finalAttempt: true }).catch(() => undefined);
    t.objects.down = false;
    expect(await statusOf(failing)).toBe('failed');
    t.clock.now += DAY;
    expect(await statusOf(pending)).toBe('expired');

    // Errors are problem+json.
    const errors = [
      await list(t.app, workspace, {}, ''),
      await list(t.app, workspace, asUser(member, READ)),
      await list(t.app, newId('wsp'), asUser(owner, READ)),
      await list(t.app, workspace, asUser(owner, READ), 'cursor=nope'),
      await list(t.app, workspace, asUser(owner, READ), 'actor=nope'),
      await requestExport(t.app, workspace, asUser(owner, READ), { format: 'pdf' }),
    ];
    expect(errors.map((r) => r.statusCode)).toEqual([401, 403, 404, 400, 422, 422]);
    for (const res of errors) {
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(validate('problem', res.json()).ok).toBe(true);
    }
    await t.app.close();
  });
});
