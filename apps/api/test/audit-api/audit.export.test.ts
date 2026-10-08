/**
 * Audit exports end to end over the in-memory repository and object store (B082): request through
 * the API, run as the `audit-export` job would (attempts 1..3), then status and download.
 *
 * - CSV (RFC 4180, formula cells neutralised) and JSON (contract `AuditEvent`s), gzip when asked;
 *   newest first, the filters applied, only events up to the request.
 * - The row cap fails the export with `row_cap_exceeded`, at once.
 * - Object storage down: 3 attempts, then `failed` with `storage_unavailable`; the list still works.
 * - A worker killed mid-stream, then an upload cut off: the job is retried, the partial object
 *   removed, and one whole object is left. Temporary files never stay.
 * - The download URL lives 900 s (never past the file's expiry); after 24 h the file is deleted
 *   and the export shows `expired`.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { newId, validate } from '@centcom/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditExportRunner,
  STALE_PENDING_MS,
  STUCK_EXPORT_MS,
} from '../../src/modules/audit-api/exporter.js';
import { ObjectStoreError } from '../../src/modules/audit-api/object-store.js';
import {
  asUser,
  auditApp,
  auditRow,
  DAY,
  list,
  requestExport,
  T0,
  team,
  type AuditApp,
} from './helpers.js';

const READ = 'audit:read';
const HOUR = 60 * 60 * 1000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audit-export-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runner(t: AuditApp, over: { maxRows?: number; batchSize?: number } = {}) {
  return new AuditExportRunner({
    repository: t.repo,
    store: t.objects,
    maxRows: over.maxRows ?? 1_000_000,
    retainMs: 24 * HOUR,
    batchSize: over.batchSize ?? 3,
    tmpDir: dir,
    clock: () => t.clock.now,
  });
}

async function status(t: AuditApp, workspace: string, owner: string, id: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspace}/audit/exports/${id}`,
    headers: asUser(owner, READ),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<Record<string, unknown>>();
  expect(validate('api/AuditExport', body).ok).toBe(true);
  return body;
}

/** Splits CSV text into rows of cells (RFC 4180, CRLF lines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += c;
  }
  return rows;
}

describe('export files', () => {
  it('writes CSV newest first, filtered, up to the request, formula cells neutralised', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    const rows = [
      auditRow(workspace, { at: T0 - 3 * HOUR, action: 'member.add' }),
      auditRow(workspace, { at: T0 - 2 * HOUR, action: 'member.remove', meta: { self: true } }),
      // Rows the database would refuse, to show every cell is guarded.
      auditRow(workspace, {
        at: T0 - HOUR,
        action: 'member.add',
        target_type: 'membership',
        target_id: '=HYPERLINK("http://evil.test","x")',
        actor_type: 'system',
        actor_id: '+retention',
      }),
      auditRow(workspace, { at: T0 - HOUR + 1, outcome: 'failed', target_id: '@SUM(A1)' }),
      auditRow(workspace, { at: T0 - 30 * 60_000, target_id: '-2+3' }),
    ];
    t.repo.add(...rows);
    t.repo.add(auditRow(workspace, { action: 'invite.create', at: T0 - HOUR })); // other action
    t.repo.add(auditRow(newId('wsp'), { at: T0 - HOUR })); // other workspace
    const res = await requestExport(t.app, workspace, asUser(owner, READ), {
      format: 'csv',
      action: 'member.add',
    });
    const id = res.json<{ id: string }>().id;
    t.repo.add(auditRow(workspace, { at: T0 + 1000, action: 'member.add' })); // after the request

    t.clock.now = T0 + 5_000;
    expect(await runner(t).run(id, { finalAttempt: false })).toBe('ready');
    expect([...t.objects.objects.keys()]).toEqual([`audit-exports/${workspace}/${id}.csv`]);
    const object = t.objects.objects.get(`audit-exports/${workspace}/${id}.csv`);
    expect(object?.contentType).toBe('text/csv; charset=utf-8');
    const text = object?.body.toString('utf8') ?? '';
    expect(text.endsWith('\r\n')).toBe(true);
    const csv = parseCsv(text);
    expect(csv[0]).toEqual([
      'id',
      'at',
      'workspace',
      'actor_type',
      'actor_id',
      'action',
      'target_type',
      'target_id',
      'result',
      'metadata',
    ]);
    const body = csv.slice(1);
    expect(body.map((r) => r[0])).toEqual([rows[4]?.id, rows[3]?.id, rows[2]?.id, rows[0]?.id]);
    expect(body[0]?.[7]).toBe("'-2+3");
    expect(body[1]?.[7]).toBe("'@SUM(A1)");
    expect(body[1]?.[8]).toBe('');
    expect(body[2]?.[4]).toBe("'+retention");
    expect(body[2]?.[7]).toBe(`'=HYPERLINK("http://evil.test","x")`);
    expect(body[3]?.slice(1, 9)).toEqual([
      rows[0]?.created_at.toISOString(),
      workspace,
      'user',
      rows[0]?.actor_id,
      'member.add',
      'membership',
      rows[0]?.target_id,
      'allowed',
    ]);
    expect(JSON.parse(body[3]?.[9] ?? '')).toEqual({ role: 'member', via: 'invite' });
    for (const line of body) {
      for (const cell of line) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }

    const ready = await status(t, workspace, owner, id);
    expect(ready).toMatchObject({ status: 'ready', format: 'csv', row_count: 4 });
    expect(ready['expires_at']).toBe(new Date(T0 + 5_000 + 24 * HOUR).toISOString());
    expect(await readdir(dir)).toEqual([]);
    await t.app.close();
  });

  it('writes JSON as contract AuditEvents, gzipped when asked', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    for (let i = 0; i < 7; i += 1) t.repo.add(auditRow(workspace, { at: T0 - (i + 1) * 1000 }));
    t.repo.add(
      auditRow(workspace, {
        at: T0 - 100,
        action: 'permission.denied',
        outcome: 'denied',
        actor_type: 'device',
        actor_id: newId('dev'),
        target_type: null,
        target_id: null,
        meta: { attempted: 'audit.read', reason: 'role', email: 'a@example.test' },
      }),
    );
    for (const gzip of [false, true]) {
      const res = await requestExport(t.app, workspace, asUser(owner, READ), {
        format: 'json',
        gzip,
      });
      const id = res.json<{ id: string }>().id;
      expect(await runner(t).run(id, { finalAttempt: false })).toBe('ready');
      const key = `audit-exports/${workspace}/${id}.json${gzip ? '.gz' : ''}`;
      const object = t.objects.objects.get(key);
      expect(object?.contentType).toBe(gzip ? 'application/gzip' : 'application/json');
      const raw = gzip ? gunzipSync(object?.body ?? Buffer.alloc(0)) : object?.body;
      const events = JSON.parse(raw?.toString('utf8') ?? '') as Record<string, unknown>[];
      expect(events).toHaveLength(8);
      for (const event of events) expect(validate('api/AuditEvent', event).ok).toBe(true);
      expect(events[0]).toEqual({
        id: expect.stringMatching(/^aud_/) as unknown,
        workspace,
        at: new Date(T0 - 100).toISOString(),
        actor: { type: 'user', id: expect.stringMatching(/^dev_/) as unknown },
        action: 'permission.denied',
        result: 'denied',
        metadata: { attempted: 'audit.read', reason: 'role' },
      });
      const ready = await status(t, workspace, owner, id);
      expect(ready['download_url']).toContain(`filename=audit-${id}.json${gzip ? '.gz' : ''}`);
    }
    await t.app.close();
  });

  it('fails an export past the row cap with row_cap_exceeded, without a retry', async () => {
    const t = await auditApp({ maxRows: 5 });
    const { workspace, owner } = await team(t);
    for (let i = 0; i < 5; i += 1) t.repo.add(auditRow(workspace, { at: T0 - (i + 1) * 1000 }));
    const res = await requestExport(t.app, workspace, asUser(owner, READ));
    expect(res.statusCode).toBe(202);
    const id = res.json<{ id: string }>().id;
    // Written late, with an earlier time (a detached audit write): the export now holds six.
    t.repo.add(auditRow(workspace, { at: T0 - 10_000 }));
    expect(await runner(t, { maxRows: 5 }).run(id, { finalAttempt: false })).toBe(
      'row_cap_exceeded',
    );
    expect(t.objects.objects.size).toBe(0);
    expect(await status(t, workspace, owner, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'row_cap_exceeded',
      download_url: null,
    });
    // A later attempt does nothing.
    expect(await runner(t, { maxRows: 5 }).run(id, { finalAttempt: true })).toBe('skipped');
    expect(await readdir(dir)).toEqual([]);
    await t.app.close();
  });
});

describe('failures', () => {
  it('retries while object storage is down, then fails with storage_unavailable', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.repo.add(auditRow(workspace));
    const id = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{ id: string }>()
      .id;
    t.objects.down = true;
    for (const finalAttempt of [false, false]) {
      await expect(runner(t).run(id, { finalAttempt })).rejects.toBeInstanceOf(ObjectStoreError);
      expect((await status(t, workspace, owner, id))['status']).toBe('pending');
    }
    await expect(runner(t).run(id, { finalAttempt: true })).rejects.toBeInstanceOf(
      ObjectStoreError,
    );
    expect(await status(t, workspace, owner, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'storage_unavailable',
    });
    // The list does not need object storage.
    expect((await list(t.app, workspace, asUser(owner, READ))).statusCode).toBe(200);
    expect(await readdir(dir)).toEqual([]);
    await t.app.close();
  });

  it('retries a worker killed mid-stream and a cut upload, leaving one whole object', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    for (let i = 0; i < 20; i += 1) t.repo.add(auditRow(workspace, { at: T0 - (i + 1) * 1000 }));
    const id = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{ id: string }>()
      .id;
    const key = `audit-exports/${workspace}/${id}.csv`;

    // Attempt 1: the stream dies after two batches; nothing reaches the store.
    t.repo.failBatchCall = 3;
    await expect(runner(t).run(id, { finalAttempt: false })).rejects.toThrow('connection lost');
    expect(t.objects.objects.size).toBe(0);
    expect(await readdir(dir)).toEqual([]);
    t.repo.failBatchCall = null;

    // Attempt 2: the upload is cut off and (in a store that kept it) half an object stays.
    t.objects.failPuts = 1;
    t.objects.keepCut = true;
    await expect(runner(t).run(id, { finalAttempt: false })).rejects.toBeInstanceOf(
      ObjectStoreError,
    );
    const cut = t.objects.objects.get(key)?.body.length ?? 0;
    expect(cut).toBeGreaterThan(0);
    expect((await status(t, workspace, owner, id))['download_url']).toBeNull();

    // Attempt 3: the partial object is removed, and one whole file written.
    expect(await runner(t).run(id, { finalAttempt: true })).toBe('ready');
    expect([...t.objects.objects.keys()]).toEqual([key]);
    const csv = parseCsv(t.objects.objects.get(key)?.body.toString('utf8') ?? '');
    expect(csv).toHaveLength(21);
    expect(new Set(csv.slice(1).map((r) => r[0])).size).toBe(20);
    expect(t.objects.objects.get(key)?.body.length).toBeGreaterThan(cut);
    expect(await readdir(dir)).toEqual([]);
    await t.app.close();
  });

  it('removes what the last attempt left, and fails it as internal for other errors', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.repo.add(auditRow(workspace));
    const id = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{ id: string }>()
      .id;
    t.repo.failBatchCall = 1;
    await expect(runner(t).run(id, { finalAttempt: true })).rejects.toThrow('connection lost');
    expect(await status(t, workspace, owner, id)).toMatchObject({
      status: 'failed',
      failure_reason: 'internal',
    });
    expect(t.objects.objects.size).toBe(0);
    await t.app.close();
  });
});

describe('download and expiry', () => {
  it('signs URLs for 900 s at most, never past the file, and deletes the file after 24 h', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.repo.add(auditRow(workspace));
    const id = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{ id: string }>()
      .id;
    expect(await runner(t).run(id, { finalAttempt: false })).toBe('ready');
    const key = `audit-exports/${workspace}/${id}.csv`;

    const ready = await status(t, workspace, owner, id);
    expect(ready['download_url']).toBe(
      `https://store.test/${key}?method=GET&ttl=900&expires=${new Date(T0 + 900_000).toISOString()}&filename=audit-${id}.csv`,
    );

    t.clock.now = T0 + 24 * HOUR - 100_000;
    const late = await status(t, workspace, owner, id);
    expect(late['download_url']).toContain('ttl=100&');

    t.clock.now = T0 + 24 * HOUR;
    const due = await status(t, workspace, owner, id);
    expect(due).toMatchObject({ status: 'expired', download_url: null });

    // The sweep deletes the file and records it; failures to delete are retried next time.
    t.objects.down = true;
    expect(await runner(t).sweep(new Date(t.clock.now))).toEqual({
      expired: 0,
      failed: 0,
      stale: [],
    });
    expect(t.repo.exports.get(id)?.status).toBe('ready');
    t.objects.down = false;
    expect(await runner(t).sweep(new Date(t.clock.now))).toEqual({
      expired: 1,
      failed: 0,
      stale: [],
    });
    expect(t.objects.objects.has(key)).toBe(false);
    expect(await status(t, workspace, owner, id)).toMatchObject({
      status: 'expired',
      download_url: null,
    });
    await t.app.close();
  });

  it('queues again exports whose job was never queued, and fails ones stuck for an hour', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.exportQueue.fail = true;
    const id = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{ id: string }>()
      .id;
    const r = runner(t);
    expect(await r.sweep(new Date(T0 + STALE_PENDING_MS - 1))).toEqual({
      expired: 0,
      failed: 0,
      stale: [],
    });
    expect(await r.sweep(new Date(T0 + STALE_PENDING_MS + 1))).toEqual({
      expired: 0,
      failed: 0,
      stale: [id],
    });
    // An hour on, its job is taken to be gone: the export fails rather than stay pending.
    expect(await r.sweep(new Date(T0 + STUCK_EXPORT_MS + 1))).toEqual({
      expired: 0,
      failed: 1,
      stale: [],
    });
    expect(t.repo.exports.get(id)).toMatchObject({ status: 'failed', error: 'internal' });
    await t.app.close();
  });

  it('applies the retention horizon to exports', async () => {
    const t = await auditApp();
    const { workspace, owner } = await team(t);
    t.repo.add(auditRow(workspace, { at: T0 - 91 * DAY }), auditRow(workspace, { at: T0 - DAY }));
    const id = (await requestExport(t.app, workspace, asUser(owner, READ))).json<{ id: string }>()
      .id;
    expect(await runner(t).run(id, { finalAttempt: false })).toBe('ready');
    expect((await status(t, workspace, owner, id))['row_count']).toBe(1);
    await t.app.close();
  });
});
