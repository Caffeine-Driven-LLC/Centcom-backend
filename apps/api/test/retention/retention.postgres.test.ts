/**
 * Data retention on Postgres 16 (B090 test plan "integration: seeded matrix of session states x
 * ages x plans against MinIO + Postgres", "idempotency and crash-restart tests", "brake test";
 * DATABASE_URL, CI's integration job): the worker's policies and runner (@centcom/worker) over
 * @centcom/db's retention repository and B055's real history store, its blobs in MinIO where a
 * container runtime is reachable (the testkit's), else in memory.
 *
 * - acceptance 1: Pro (7 days), Team (30) and free (0) workspaces with sessions in every state and
 *   at several ages: exactly the ended or expired sessions past their plan's days lose their
 *   blobs, index rows and retention rows; pending, live and paused ones never do;
 * - acceptance 2: a second run deletes nothing and reports no error; a run that died is closed as
 *   `interrupted`, and a run that failed half way is finished by the next one;
 * - failure path: B055's real store over blob deletes that fail for some keys: the run completes,
 *   every index row left still has its blob, and the next run finishes;
 * - acceptance 3: a downgrade from 30 to 7 days writes one `retention_pending` row, one notice and
 *   one email (each marked with when it went out), purges nothing newer than 30 days until 7 days
 *   later (± 5 min), then applies;
 * - acceptance 5: a dry run deletes nothing (rows and blobs counted) and reports `dry_run`;
 * - acceptance 6: a corrupted `history_days: 0` aborts the policy with `fraction_exceeded`,
 *   deleting nothing, until forced;
 * - acceptance 7: device codes 10 minutes past expiry, expired magic-link tokens, refresh-token
 *   families past their absolute expiry (whole families), finished invites and old revoked API
 *   keys go; nothing unexpired does;
 * - the other datasets' rules (webhook log, notifications, exports, Stripe events, outbox,
 *   trials), audit events through `purge_audit_events()` with their staff details (and the audit
 *   bookkeeping), and the read-only telemetry report (an event 91 days old counted, one 89 days
 *   old not, neither deleted);
 * - acceptance 8: `purgeWorkspace` removes a 10 000-frame history (blobs and rows) within 5 min
 *   and writes a `history.purge` audit event with the counts;
 * - the retention tables go with their workspace and refuse bad values.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createAuditEmitter, createMemoryRedis, Secret } from '@centcom/core';
import { createRetentionRepository, type HistoryDatabase, type RetentionDb } from '@centcom/db';
import { amzDate, authorizationHeader, canonicalPath, EMPTY_SHA256 } from '@centcom/storage';
import { startMinio, testcontainersRuntime, type TestMinio } from '@centcom/testkit';
import {
  createDecideCursor,
  createPolicyLock,
  createRetentionPolicies,
  createWorkspacePurger,
  RetentionRunner,
  type RetentionPolicy,
  type RetentionRunConfig,
  type SessionBlobPurger,
} from '@centcom/worker';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlobStoreError,
  createHistoryStore,
  createMemoryBlobStore,
  createS3BlobStore,
  historyPrefix,
  type BlobStore,
} from '../../src/modules/history/index.js';
import { newId, storedRange } from '../history/helpers.js';
import type { TestDatabase } from '../modules/users/helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgJoin,
  pgSession,
  pgUser,
  pgWorkspace,
} from '../notifications/dispatcher/postgres.js';

const RUNTIME = await testcontainersRuntime.check().then(
  () => true,
  () => false,
);
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const PRO = { history_days: 7, audit_log_days: 0 };
const TEAM = { history_days: 30, audit_log_days: 90 };
const FREE = { history_days: 0, audit_log_days: 0 };
const LIVE: RetentionRunConfig = { dryRun: false, force: false, maxDeleteFraction: 0.2 };
const FORCED: RetentionRunConfig = { ...LIVE, force: true };

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

type Db = Kysely<RetentionDb & HistoryDatabase>;

async function minioBucket(minio: TestMinio, bucket: string): Promise<void> {
  const endpoint = new URL(minio.endpoint);
  const now = new Date();
  const headers = { 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate(now) };
  const segments = [bucket];
  const authorization = authorizationHeader(
    { method: 'PUT', host: endpoint.host, segments, headers },
    { ...minio, service: 's3' },
    now,
    EMPTY_SHA256,
  );
  const res = await fetch(`${minio.endpoint}${canonicalPath(segments)}`, {
    method: 'PUT',
    headers: { ...headers, authorization },
  });
  expect(res.status).toBe(200);
}

describe.runIf(ADMIN_URL !== undefined)('data retention on Postgres 16', () => {
  let minio: TestMinio | undefined;
  let blobs: BlobStore;

  beforeAll(async () => {
    if (!RUNTIME) {
      blobs = createMemoryBlobStore();
      return;
    }
    minio = await startMinio();
    await minioBucket(minio, 'retention');
    blobs = createS3BlobStore({
      endpoint: minio.endpoint,
      region: minio.region,
      bucket: 'retention',
      accessKeyId: new Secret(minio.accessKeyId),
      secretAccessKey: new Secret(minio.secretAccessKey),
    });
  }, 180_000);
  afterAll(async () => {
    await minio?.stop();
  });

  async function setup() {
    const t: TestDatabase = await migratedDatabase(10);
    const db = t.db as unknown as Db;
    const repo = createRetentionRepository(db);
    const history = createHistoryStore({ db: t.db as unknown as Kysely<HistoryDatabase>, blobs });
    const limits = new Map<string, Record<string, unknown>>();
    const notices: { channel: string; message: unknown }[] = [];
    const mails: { to: string; days: string; key: string }[] = [];
    const now = new Date();
    const owner = await pgUser(t.db);
    // One Redis for every run of the test, so the cursor carries over between them.
    const redis = createMemoryRedis();

    const policiesWith = (purger: SessionBlobPurger = history): RetentionPolicy[] =>
      createRetentionPolicies({
        cursor: createDecideCursor(redis.kv),
        stores: {
          state: repo.state,
          history: repo.history,
          audit: repo.audit,
          telemetry: repo.telemetry,
          rows: repo.rows,
        },
        history: purger,
        entitlements: {
          get: (ws) => Promise.resolve(limits.has(ws) ? { limits: { ...limits.get(ws) } } : null),
        },
        notices: {
          publish: (channel, message) => {
            notices.push({ channel, message: JSON.parse(message) as unknown });
            return Promise.resolve();
          },
        },
        mailer: {
          send: (_id, to, params, opts) => {
            mails.push({ to, days: params.days, key: opts.idempotencyKey });
            return Promise.resolve();
          },
        },
      });
    const run = (
      opts: {
        config?: RetentionRunConfig;
        policy?: string;
        at?: Date;
        purger?: SessionBlobPurger;
      } = {},
    ) =>
      new RetentionRunner({
        policies: policiesWith(opts.purger),
        lock: createPolicyLock(redis.kv),
        runs: repo.runs,
        config: opts.config ?? LIVE,
      }).run({
        ...(opts.policy === undefined ? {} : { policy: opts.policy }),
        now: opts.at ?? now,
      });

    /** A workspace with an owner and the plan's limits. */
    const workspace = async (plan: Record<string, unknown> | null = PRO): Promise<string> => {
      const ws = await pgWorkspace(t.db, owner);
      await pgJoin(t.db, ws, owner, 'owner');
      if (plan !== null) limits.set(ws, plan);
      return ws;
    };
    /** A session holding `frames` frames (500 per blob), in `state`, ended `endedDaysAgo` ago. */
    const session = async (
      ws: string,
      opts: { state?: string; endedDaysAgo?: number | null; frames?: number } = {},
    ): Promise<string> => {
      const sid = await pgSession(t.db, ws, owner);
      const frames = opts.frames ?? 10;
      for (let from = 1; from <= frames; from += 500) {
        await history.append(sid, storedRange(sid, from, Math.min(frames, from + 499)));
      }
      const endedDaysAgo = opts.endedDaysAgo === undefined ? 1 : opts.endedDaysAgo;
      const endedAt = endedDaysAgo === null ? null : new Date(now.getTime() - endedDaysAgo * DAY);
      await sql`update sessions set state = ${opts.state ?? 'ended'}, ended_at = ${endedAt}
        where id = ${sid}`.execute(db);
      if (endedAt !== null) await history.setExpiry(sid, endedAt);
      return sid;
    };
    const frames = async (sid: string): Promise<number> =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*) as n from history_index where session_id = ${sid}`.execute(db)
        ).rows[0]?.n,
      );
    const retained = async (sid: string): Promise<boolean> =>
      (await sql`select 1 from history_retention where session_id = ${sid}`.execute(db)).rows
        .length > 0;
    const runs = () => db.selectFrom('retention_runs').selectAll().orderBy('id').execute();
    return {
      t,
      db,
      repo,
      history,
      limits,
      notices,
      mails,
      now,
      owner,
      run,
      workspace,
      session,
      frames,
      retained,
      runs,
    };
  }

  it('purges exactly the ended sessions past their plan, in every state and age (acceptance 1)', async () => {
    const s = await setup();
    try {
      const pro = await s.workspace(PRO);
      const team = await s.workspace(TEAM);
      const free = await s.workspace(FREE);
      const gone = [
        await s.session(pro, { endedDaysAgo: 8, frames: 20 }),
        await s.session(pro, { state: 'expired', endedDaysAgo: 9, frames: 12 }),
        await s.session(team, { endedDaysAgo: 31, frames: 30 }),
        await s.session(free, { endedDaysAgo: 1, frames: 5 }),
      ];
      const kept = [
        await s.session(pro, { endedDaysAgo: 6, frames: 600 }),
        await s.session(pro, { state: 'live', endedDaysAgo: null, frames: 50 }),
        await s.session(pro, { state: 'paused', endedDaysAgo: null, frames: 50 }),
        await s.session(pro, { state: 'pending', endedDaysAgo: null, frames: 50 }),
        await s.session(team, { endedDaysAgo: 8, frames: 40 }),
      ];
      const [report] = await s.run({ policy: 'history' });
      expect(report).toMatchObject({ policy: 'history', outcome: 'done', purged: 67, skipped: 0 });
      for (const sid of gone) {
        expect(await s.frames(sid), sid).toBe(0);
        expect(await s.retained(sid)).toBe(false);
        expect(await blobs.list(historyPrefix(sid))).toEqual([]);
      }
      for (const sid of kept) {
        expect(await s.frames(sid), sid).toBeGreaterThan(0);
        expect((await blobs.list(historyPrefix(sid))).length).toBeGreaterThan(0);
      }
      expect(await s.frames(kept[0] ?? '')).toBe(600);
      expect((await blobs.list(historyPrefix(kept[0] ?? ''))).length).toBe(2);
      expect(await s.runs()).toEqual([
        expect.objectContaining({
          policy: 'history',
          purged: '67',
          dry_run: false,
          aborted_reason: null,
        }),
      ]);
      expect(
        await s.db
          .selectFrom('retention_baseline')
          .select(['workspace_id', 'days'])
          .where('dataset', '=', 'history')
          .orderBy('days')
          .execute(),
      ).toEqual([
        { workspace_id: free, days: 0 },
        { workspace_id: pro, days: 7 },
        { workspace_id: team, days: 30 },
      ]);
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('deletes nothing on a second run, and finishes a run that died or failed (acceptance 2)', async () => {
    const s = await setup();
    try {
      const ws = await s.workspace(PRO);
      const first = await s.session(ws, { endedDaysAgo: 30 });
      const second = await s.session(ws, { endedDaysAgo: 30 });
      await s.session(ws, { endedDaysAgo: 1, frames: 200 });
      await s.repo.runs.start('history', false, new Date(s.now.getTime() - DAY)); // a dead worker's
      let purges = 0;
      const killed: SessionBlobPurger = {
        purge: (sid) => {
          purges += 1;
          if (purges > 1) return Promise.reject(new Error('worker killed'));
          return s.history.purge(sid);
        },
      };
      expect((await s.run({ policy: 'history', purger: killed }))[0]).toMatchObject({
        outcome: 'done',
        purged: 10,
        skipped: 10,
      });
      expect([await s.frames(first), await s.frames(second)].sort()).toEqual([0, 10]);
      expect((await s.run({ policy: 'history' }))[0]).toMatchObject({ purged: 10, skipped: 0 });
      expect(await s.frames(first)).toBe(0);
      expect(await s.frames(second)).toBe(0);
      expect((await s.run({ policy: 'history' }))[0]).toMatchObject({ scanned: 0, purged: 0 });
      expect((await s.runs()).map((r) => r.aborted_reason)).toEqual([
        'interrupted',
        null,
        null,
        null,
      ]);
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('leaves every index row with its blob when some blob deletes fail, and finishes next run', async () => {
    const s = await setup();
    try {
      const ws = await s.workspace(PRO);
      const sessions = [
        await s.session(ws, { endedDaysAgo: 30, frames: 1_200 }), // 3 blobs each
        await s.session(ws, { endedDaysAgo: 30, frames: 1_200 }),
        await s.session(ws, { endedDaysAgo: 30, frames: 1_200 }),
      ];
      await s.session(ws, { endedDaysAgo: 1, frames: 20_000 }); // keeps the brake quiet
      // Every 4th delete fails, as a store failing about 10 % of the time would.
      let deletes = 0;
      const flaky: BlobStore = {
        ...blobs,
        async delete(keys) {
          deletes += 1;
          if (deletes % 4 === 0) throw new BlobStoreError('DELETE answered 500');
          await blobs.delete(keys);
        },
      };
      const flakyHistory = createHistoryStore({
        db: s.t.db as unknown as Kysely<HistoryDatabase>,
        blobs: flaky,
      });
      const [first] = await s.run({ policy: 'history', purger: flakyHistory });
      expect(first).toMatchObject({ outcome: 'done' });
      expect(first?.skipped).toBeGreaterThan(0);
      for (const sid of sessions) {
        const keys = await sql<{ blob_key: string }>`
          select distinct blob_key from history_index where session_id = ${sid}`.execute(s.db);
        const listed = await blobs.list(historyPrefix(sid));
        for (const { blob_key } of keys.rows) expect(listed).toContain(blob_key);
      }
      const [second] = await s.run({ policy: 'history' });
      expect(second).toMatchObject({ outcome: 'done', skipped: 0 });
      for (const sid of sessions) {
        expect(await s.frames(sid)).toBe(0);
        expect(await blobs.list(historyPrefix(sid))).toEqual([]);
      }
    } finally {
      await s.t.drop();
    }
  }, 300_000);

  it('gives 7 days of notice on a downgrade, once, then purges (acceptance 3)', async () => {
    const s = await setup();
    try {
      const ws = await s.workspace(TEAM);
      const tenDays = await s.session(ws, { endedDaysAgo: 10, frames: 20 });
      await s.session(ws, { endedDaysAgo: 1, frames: 200 });
      await s.run({ policy: 'history' });
      s.limits.set(ws, PRO);
      await s.run({ policy: 'history' });
      const effectiveAt = new Date(s.now.getTime() + 7 * DAY);
      const pending = await s.db.selectFrom('retention_pending').selectAll().execute();
      expect(pending).toEqual([
        expect.objectContaining({
          workspace_id: ws,
          dataset: 'history',
          old_days: 30,
          new_days: 7,
          effective_at: effectiveAt,
          notice_sent_at: expect.any(Date),
          email_sent_at: expect.any(Date),
        }),
      ]);
      // Marked with the wall clock when each went out, at or after the run's instant.
      for (const sentAt of [pending[0]?.notice_sent_at, pending[0]?.email_sent_at]) {
        expect(sentAt?.getTime()).toBeGreaterThanOrEqual(s.now.getTime());
        expect(sentAt?.getTime()).toBeLessThan(s.now.getTime() + 2 * MIN);
      }
      expect(s.notices).toEqual([
        {
          channel: `relay:notice:${ws}`,
          message: { code: 'history_retention_changed', level: 'info', params: { days: 7 } },
        },
      ]);
      const ownerEmail = await s.db
        .selectFrom('users')
        .select('email')
        .where('id', '=', s.owner)
        .executeTakeFirstOrThrow();
      expect(s.mails).toEqual([
        {
          to: String(ownerEmail.email),
          days: '7',
          key: `retention:${ws}:${effectiveAt.getTime()}`,
        },
      ]);

      await s.run({ policy: 'history', at: new Date(effectiveAt.getTime() - 5 * MIN) });
      expect(await s.frames(tenDays)).toBe(20);
      expect(s.notices).toHaveLength(1);
      expect(s.mails).toHaveLength(1);
      await s.run({
        policy: 'history',
        at: new Date(effectiveAt.getTime() + 5 * MIN),
        config: FORCED,
      });
      expect(await s.frames(tenDays)).toBe(0);
      expect(await s.db.selectFrom('retention_pending').selectAll().execute()).toEqual([]);
      expect(
        await s.db
          .selectFrom('retention_baseline')
          .select('days')
          .where('workspace_id', '=', ws)
          .where('dataset', '=', 'history')
          .executeTakeFirst(),
      ).toEqual({ days: 7 });
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('deletes nothing in a dry run and reports it (acceptance 5)', async () => {
    const s = await setup();
    try {
      const ws = await s.workspace(PRO);
      const sid = await s.session(ws, { endedDaysAgo: 30, frames: 40 });
      await s.session(ws, { endedDaysAgo: 1, frames: 400 });
      const before = (await blobs.list(historyPrefix(sid))).length;
      const reports = await s.run({ config: { ...LIVE, dryRun: true } });
      expect(reports.find((r) => r.policy === 'history')).toMatchObject({ scanned: 40, purged: 0 });
      expect(await s.frames(sid)).toBe(40);
      expect((await blobs.list(historyPrefix(sid))).length).toBe(before);
      expect(reports.every((r) => r.outcome === 'done')).toBe(true);
      const rows = await s.runs();
      expect(rows).toHaveLength(17);
      expect(rows.every((r) => r.dry_run && r.purged === '0' && r.aborted_reason === null)).toBe(
        true,
      );
      expect(await s.db.selectFrom('retention_baseline').selectAll().execute()).toEqual([]);
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('aborts on a corrupted history_days of 0, deleting nothing, until forced (acceptance 6)', async () => {
    const s = await setup();
    try {
      for (let i = 0; i < 3; i += 1) {
        const ws = await s.workspace({ ...TEAM, history_days: 0 });
        await s.session(ws, { endedDaysAgo: 2, frames: 100 });
      }
      const team = await s.workspace(TEAM);
      await s.session(team, { endedDaysAgo: 2, frames: 100 });
      expect((await s.run({ policy: 'history' }))[0]).toMatchObject({
        outcome: 'fraction_exceeded',
        scanned: 300,
        purged: 0,
      });
      expect((await s.runs())[0]).toMatchObject({
        aborted_reason: 'fraction_exceeded',
        purged: '0',
      });
      expect(
        Number(
          (await sql<{ n: string }>`select count(*) as n from history_index`.execute(s.db)).rows[0]
            ?.n,
        ),
      ).toBe(400);
      expect((await s.run({ policy: 'history', config: FORCED }))[0]).toMatchObject({
        purged: 300,
      });
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('deletes expired codes, tokens, families and finished invites only (acceptance 7)', async () => {
    const s = await setup();
    try {
      const ws = await s.workspace(PRO);
      const ago = (ms: number) => new Date(s.now.getTime() - ms);
      const later = (ms: number) => new Date(s.now.getTime() + ms);
      // Device-flow grants: 11 minutes past expiry goes; 9 minutes past and unexpired stay.
      const grant = async (expiresAt: Date, userCode: string, denied = false) => {
        const hash = hex(32);
        await sql`insert into device_grants (device_code_hash, user_code, client_id, scope, device_name,
            platform, x25519_pub, ed25519_pub, expires_at, status, user_id, decided_at)
          values (${hash}, ${userCode}, 'centcom-cli', 'sessions:read', 'laptop', 'linux',
            ${'A'.repeat(43)}, ${'B'.repeat(43)}, ${expiresAt}, ${denied ? 'denied' : 'pending'},
            ${denied ? s.owner : null}, ${denied ? ago(20 * MIN) : null})`.execute(s.db);
        return hash;
      };
      // Whatever their status: the expired one was denied.
      const grants = [
        await grant(ago(11 * MIN), 'ABCDEFGH', true),
        await grant(ago(9 * MIN), 'ABCDEFGJ'),
        await grant(later(MIN), 'ABCDEFGK'),
      ];
      // Magic-link tokens: expired goes, live stays.
      const token = async (expiresAt: Date) => {
        const hash = hex(32);
        await sql`insert into login_tokens (token_hash, nonce_hash, email, return_to, expires_at)
          values (${hash}, ${hex(32)}, 'a@example.test', '/', ${expiresAt})`.execute(s.db);
        return hash;
      };
      const tokens = [await token(ago(MIN)), await token(later(10 * MIN))];
      // Refresh-token families: a three-token chain past its absolute expiry goes whole.
      const family = async (absolute: Date) => {
        const id = hex(16);
        let parent: string | null = null;
        for (let i = 0; i < 3; i += 1) {
          const hash = sha(`${id}-${i}`);
          const expires = absolute.getTime() < s.now.getTime() ? absolute : later(DAY);
          await sql`insert into refresh_tokens (token_hash, family_id, parent_hash, user_id, client_id,
              scope, expires_at, absolute_expires_at)
            values (${hash}, ${id}, ${parent}, ${s.owner}, 'centcom-cli', 'sessions:read',
              ${expires}, ${absolute})`.execute(s.db);
          parent = hash;
        }
        return id;
      };
      const families = [await family(ago(DAY)), await family(later(100 * DAY))];
      // Invites: accepted or expired over 30 days ago go; revoked 29 days ago and pending stay.
      const invite = async (cols: { accepted?: Date; revoked?: Date; expires: Date }) => {
        const id = newId('inv');
        await sql`insert into invites (id, workspace_id, role, token_hash, created_by, created_at,
            expires_at, accepted_at, accepted_by, revoked_at)
          values (${id}, ${ws}, 'member', ${randomBytes(32)}, ${s.owner}, ${ago(60 * DAY)},
            ${cols.expires}, ${cols.accepted ?? null}, ${cols.accepted === undefined ? null : s.owner},
            ${cols.revoked ?? null})`.execute(s.db);
        return id;
      };
      const invites = [
        await invite({ accepted: ago(31 * DAY), expires: ago(25 * DAY) }),
        await invite({ expires: ago(31 * DAY) }),
        await invite({ revoked: ago(29 * DAY), expires: later(DAY) }),
        await invite({ expires: later(DAY) }),
      ];

      const first = await s.run({ config: FORCED });
      expect(first.filter((r) => r.outcome !== 'done')).toEqual([]);
      const left = async (table: string, column: string, ids: string[]) =>
        (
          await sql<{
            id: string;
          }>`select ${sql.ref(column)} as id from ${sql.table(table)}`.execute(s.db)
        ).rows
          .map((r) => r.id)
          .filter((id) => ids.includes(id))
          .sort();
      expect(await left('device_grants', 'device_code_hash', grants)).toEqual(
        grants.slice(1).sort(),
      );
      expect(await left('login_tokens', 'token_hash', tokens)).toEqual([tokens[1]]);
      expect(await left('refresh_tokens', 'family_id', families)).toEqual([
        families[1],
        families[1],
        families[1],
      ]);
      expect(await left('invites', 'id', invites)).toEqual(invites.slice(2).sort());
      // Again: nothing more, and no errors.
      const again = await s.run({ config: FORCED });
      expect(again.filter((r) => r.purged > 0 || r.outcome !== 'done')).toEqual([]);
      expect((await s.runs()).every((r) => r.aborted_reason === null)).toBe(true);
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('applies the other datasets’ rules: webhook log, inbox, exports, Stripe, outbox, trials', async () => {
    const s = await setup();
    try {
      const ws = await s.workspace(PRO);
      const ago = (ms: number) => new Date(s.now.getTime() - ms);
      const endpoint = newId('whk');
      await sql`insert into webhook_endpoints (id, workspace_id, url, events, secret_enc)
        values (${endpoint}, ${ws}, 'https://hooks.example.test', ${['session.created']},
          ${JSON.stringify({ v: 1 })}::jsonb)`.execute(s.db);
      const event = async (age: number) => {
        const id = `evt-${hex(8)}`;
        await sql`insert into webhook_events (id, workspace_id, type, data, created_at)
          values (${id}, ${ws}, 'session.created', '{}'::jsonb, ${ago(age)})`.execute(s.db);
        await sql`insert into webhook_deliveries (id, endpoint_id, event_id, event_type, created_at)
          values (${newId('dlv')}, ${endpoint}, ${id}, 'session.created', ${ago(age)})`.execute(
          s.db,
        );
        return id;
      };
      const events = [await event(31 * DAY), await event(29 * DAY)];
      const note = async (age: number) => {
        const id = newId('ntf');
        await sql`insert into notifications (id, user_id, event_id, category, priority, channels, created_at)
          values (${id}, ${s.owner}, ${hex(8)}, 'mention', 'normal', ${['inbox']}, ${ago(age)})`.execute(
          s.db,
        );
        return id;
      };
      const notes = [await note(91 * DAY), await note(89 * DAY)];
      const accountExport = async (status: string, expiresAgo: number) => {
        const id = newId('exp');
        await sql`insert into account_exports (id, user_id, status, created_at, updated_at, expires_at)
          values (${id}, ${s.owner}, ${status}, ${ago(60 * DAY)}, ${ago(expiresAgo)}, ${ago(expiresAgo)})`.execute(
          s.db,
        );
        return id;
      };
      const exportsMade = [
        await accountExport('expired', 31 * DAY),
        await accountExport('failed', 31 * DAY),
        await accountExport('expired', 29 * DAY),
        await accountExport('ready', 31 * DAY), // not expired yet by status: B026's sweep first
      ];
      const auditExport = async (status: string, expiresAgo: number) => {
        const id = newId('exp');
        await sql`insert into audit_export_jobs (id, workspace_id, requested_by, format, filters, status,
            created_at, completed_at, expires_at)
          values (${id}, ${ws}, ${s.owner}, 'csv', '{}'::jsonb, ${status}, ${ago(60 * DAY)},
            ${ago(expiresAgo)}, ${ago(expiresAgo)})`.execute(s.db);
        return id;
      };
      const auditExports = [
        await auditExport('expired', 31 * DAY),
        await auditExport('expired', 2 * DAY),
      ];
      const stripe = async (status: string, age: number) => {
        const id = `evt_${hex(8)}`;
        await sql`insert into stripe_event (event_id, type, created_at_stripe, status, received_at)
          values (${id}, 'invoice.paid', ${ago(age)}, ${status}, ${ago(age)})`.execute(s.db);
        return id;
      };
      const stripeEvents = [
        await stripe('processed', 91 * DAY),
        await stripe('ignored', 91 * DAY),
        await stripe('failed', 91 * DAY),
        await stripe('processed', 89 * DAY),
      ];
      await sql`insert into billing_outbox (type, workspace_id, payload, dedupe_key, published_at)
        values ('billing.plan_changed', ${ws}, '{}'::jsonb, 'old', ${ago(31 * DAY)}),
               ('billing.plan_changed', ${ws}, '{}'::jsonb, 'recent', ${ago(DAY)}),
               ('billing.plan_changed', ${ws}, '{}'::jsonb, 'unpublished', null)`.execute(s.db);
      await sql`insert into billing_trials (stripe_subscription_id, workspace_id, trial_end, created_at)
        values ('sub_old', null, ${ago(800 * DAY)}, ${ago(830 * DAY)}),
               ('sub_recent', ${ws}, ${ago(10 * DAY)}, ${ago(40 * DAY)})`.execute(s.db);
      await sql`insert into billing_trial_owners (stripe_subscription_id, user_id)
        values ('sub_old', ${s.owner}), ('sub_recent', ${s.owner})`.execute(s.db);
      // Raw telemetry (B085's day partitions) 91 and 89 days old: reported, never deleted.
      for (const age of [91, 89]) {
        const day = ago(age * DAY)
          .toISOString()
          .slice(0, 10);
        await sql`select telemetry_ensure_partition(${day}::date)`.execute(s.db);
        await sql`insert into telemetry_events (day, install_id, type, at)
          values (${day}::date, ${'0'.repeat(26)}, 'app.start', ${ago(age * DAY)})`.execute(s.db);
      }

      const reports = await s.run({ config: FORCED });
      expect(reports.filter((r) => r.outcome !== 'done')).toEqual([]);
      expect(reports.find((r) => r.policy === 'telemetry')).toMatchObject({
        scanned: 1,
        purged: 0,
      });
      const telemetry = await sql<{
        n: string;
      }>`select count(*) as n from telemetry_events`.execute(s.db);
      expect(Number(telemetry.rows[0]?.n)).toBe(2);
      const ids = async (q: RawBuilder<{ id: string }>) =>
        (await q.execute(s.db)).rows.map((r) => r.id).sort();
      expect(await ids(sql`select id from webhook_events`)).toEqual([events[1]]);
      expect(await ids(sql`select event_id as id from webhook_deliveries`)).toEqual([events[1]]);
      expect(await ids(sql`select id from notifications`)).toEqual([notes[1]]);
      expect(await ids(sql`select id from account_exports`)).toEqual(exportsMade.slice(2).sort());
      expect(await ids(sql`select id from audit_export_jobs`)).toEqual([auditExports[1]]);
      expect(await ids(sql`select event_id as id from stripe_event`)).toEqual(
        stripeEvents.slice(2).sort(),
      );
      expect(await ids(sql`select dedupe_key as id from billing_outbox`)).toEqual([
        'recent',
        'unpublished',
      ]);
      expect(await ids(sql`select stripe_subscription_id as id from billing_trials`)).toEqual([
        'sub_recent',
      ]);
      expect(await ids(sql`select stripe_subscription_id as id from billing_trial_owners`)).toEqual(
        ['sub_recent'],
      );
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('keeps audit_log_days of events through purge_audit_events, and their staff details', async () => {
    const s = await setup();
    try {
      const team = await s.workspace(TEAM);
      const pro = await s.workspace(PRO);
      const event = async (ws: string | null, age: number) => {
        const id = newId('aud');
        await sql`insert into audit_events (id, workspace_id, actor_type, actor_id, action, outcome, created_at)
          values (${id}, ${ws}, 'system', 'test', 'workspace.update', 'success',
            ${new Date(s.now.getTime() - age)})`.execute(s.db);
        return id;
      };
      const old = await event(team, 100 * DAY);
      const recent = await event(team, 10 * DAY);
      const proEvent = await event(pro, 60 * MIN);
      const account = await event(null, 400 * DAY);
      await sql`insert into staff_audit_details (audit_id, reason) values
        (${old}, 'support ticket 1234'), (${recent}, 'support ticket 5678')`.execute(s.db);
      const reports = await s.run({ config: FORCED });
      expect(reports.filter((r) => r.outcome !== 'done')).toEqual([]);
      expect(
        await s.db
          .selectFrom('retention_baseline')
          .select(['workspace_id', 'days'])
          .where('dataset', '=', 'audit')
          .orderBy('days')
          .execute(),
      ).toEqual([
        { workspace_id: pro, days: 0 },
        { workspace_id: team, days: 90 },
      ]);
      const left = (await sql<{ id: string }>`select id from audit_events`.execute(s.db)).rows
        .map((r) => r.id)
        .sort();
      expect(left).toEqual([recent, account].sort());
      expect(left).not.toContain(proEvent);
      expect(
        (await sql<{ id: string }>`select audit_id as id from staff_audit_details`.execute(s.db))
          .rows,
      ).toEqual([{ id: recent }]);
    } finally {
      await s.t.drop();
    }
  }, 120_000);

  it('purges a deleted workspace’s 10 000-frame history within 5 min, with an audit event (acceptance 8)', async () => {
    const s = await setup();
    try {
      const ws = await s.workspace(PRO);
      const other = await s.workspace(PRO);
      const sessions = [
        await s.session(ws, { state: 'live', endedDaysAgo: null, frames: 5_000 }),
        await s.session(ws, { endedDaysAgo: 1, frames: 4_500 }),
        await s.session(ws, { state: 'paused', endedDaysAgo: null, frames: 500 }),
      ];
      const kept = await s.session(other, { endedDaysAgo: 1, frames: 10 });
      const audit = createAuditEmitter({ db: s.t.db });
      const purger = createWorkspacePurger({
        sessions: s.repo.sessions,
        history: s.history,
        audit,
      });
      const started = performance.now();
      expect(await purger.purgeWorkspace(ws)).toEqual({ blobs: 20, rows: 10_000 });
      expect(performance.now() - started).toBeLessThan(5 * 60 * 1000);
      await audit.flush(5_000);
      for (const sid of sessions) {
        expect(await s.frames(sid)).toBe(0);
        expect(await s.retained(sid)).toBe(false);
        expect(await blobs.list(historyPrefix(sid))).toEqual([]);
      }
      expect(await s.frames(kept)).toBe(10);
      const events = await sql<{
        workspace_id: string | null;
        actor_type: string;
        actor_id: string;
        target_type: string;
        target_id: string;
        meta: unknown;
      }>`select workspace_id, actor_type, actor_id, target_type, target_id, meta from audit_events
        where action = 'history.purge'`.execute(s.db);
      expect(events.rows).toEqual([
        {
          workspace_id: null,
          actor_type: 'system',
          actor_id: 'retention',
          target_type: 'workspace',
          target_id: ws,
          meta: { frames: 10_000, blobs: 20 },
        },
      ]);
      expect(await purger.purgeWorkspace(ws)).toEqual({ blobs: 0, rows: 0 });
    } finally {
      await s.t.drop();
    }
  }, 300_000);

  it('drops the retention tables’ rows with their workspace, and refuses bad values', async () => {
    const s = await setup();
    try {
      const ws = await pgWorkspace(s.t.db, s.owner);
      await s.repo.state.setBaseline(ws, 'history', 30);
      await s.repo.state.setBaseline(ws, 'audit', 90);
      await s.repo.state.announce(ws, 'history', {
        oldDays: 30,
        newDays: 7,
        effectiveAt: new Date(s.now.getTime() + 7 * DAY),
        noticeSentAt: null,
        emailSentAt: null,
      });
      for (const bad of [
        sql`insert into retention_pending (workspace_id, dataset, old_days, new_days, effective_at)
          values (${await pgWorkspace(s.t.db, s.owner)}, 'history', 7, 7, now())`,
        sql`insert into retention_baseline (workspace_id, dataset, days)
          values (${await pgWorkspace(s.t.db, s.owner)}, 'history', -1)`,
        sql`insert into retention_baseline (workspace_id, dataset, days)
          values (${await pgWorkspace(s.t.db, s.owner)}, 'snapshots', 7)`,
        sql`insert into retention_runs (policy, dry_run) values ('Bad Policy', false)`,
        sql`insert into retention_runs (policy, dry_run, aborted_reason) values ('history', false, 'oops')`,
      ]) {
        await expect(bad.execute(s.db)).rejects.toThrow(/check constraint/);
      }
      await sql`delete from workspaces where id = ${ws}`.execute(s.db);
      expect(await s.db.selectFrom('retention_pending').selectAll().execute()).toEqual([]);
      expect(await s.db.selectFrom('retention_baseline').selectAll().execute()).toEqual([]);
    } finally {
      await s.t.drop();
    }
  }, 120_000);
});
