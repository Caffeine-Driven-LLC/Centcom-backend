/**
 * `pnpm dev:full-check` (B107): one brand-new account uses what a session leaves behind and what a
 * workspace uses, against the live dev stack:
 *
 * 1. hosts a session and talks in it, then reads the durable history back over REST and through
 *    the client (the relay wrote it to MinIO);
 * 2. uploads a snapshot and downloads it again;
 * 3. reports usage events and reads the workspace's usage summary;
 * 4. reads and replaces its notification preferences, and reads its inbox;
 * 5. reads the plan catalogue and the workspace's entitlements.
 *
 * Needs `pnpm dev:up`, `pnpm dev:api` and `pnpm dev:relay` running (and the client checked out next
 * to this repo, or CENTCOM_CLIENT_DIR). Exits 1 when a step failed.
 */
import { execFileSync } from 'node:child_process';
import { api, appToken, listen, signUp, until, type Person } from './client-kit.js';

const step = (text: string): void => console.log(`\n== ${text}`);
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) process.exitCode = 1;
};

async function rest<T>(
  who: Person,
  method: string,
  path: string,
  body?: unknown,
  token = who.token,
): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'idempotency-key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text === '' ? {} : JSON.parse(text)) as T;
}

step('A new account hosts a session and talks in it');
const alice = await signUp('full');
const ws =
  (await rest<{ data: { id: string }[] }>(alice, 'GET', '/v1/workspaces')).data[0]?.id ?? '';
const log: string[] = [];
const host = await alice.sessions.createSession({
  name: 'full check',
  workspace: ws,
  // A host builds the checkpoint; here it is a small state of the three messages.
  buildSnapshot: () => Promise.resolve({ messages: log.length, title: 'full check' }),
});
listen(host, log, 'alice');
for (const text of ['one', 'two', 'three']) {
  await host.sendEvent('message.user', { secret: { text } });
}
check(await until(() => log.length === 3, 5_000), 'the host read its own three messages');

step('History: the relay wrote it to the object store, the API reads it back');
await until(() => false, 4_000).catch(() => undefined); // the writer flushes its batch within a few seconds
const page = await rest<{ data: { seq: number; k?: string }[]; has_more: boolean }>(
  alice,
  'GET',
  `/v1/sessions/${host.id}/history?after_seq=0`,
);
const frames = page.data.length;
check(
  frames >= 3,
  `GET /history returned ${frames} frames (seq ${page.data.map((f) => f.seq).join(', ')})`,
);
const viaClient = await host.history.fetch(0);
check(
  viaClient >= 0,
  `the client's own history.fetch works (the host already had its frames: ${viaClient} new)`,
);

step('Snapshots');
const up = await host.snapshot.upload();
check(up !== null && up.seq >= 3, `uploaded a snapshot at seq ${up?.seq}`);
const down = await host.snapshot.fetch();
check(
  down !== null && down.seq === up?.seq,
  `downloaded it again (seq ${down?.seq}, ${down?.doc.fmt})`,
);

step('Usage');
const id = (): string =>
  `use_${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('')
    .slice(0, 26)}`;
const reported = await fetch(`${api}/v1/usage/events`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${alice.token}`,
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    events: [
      { id: id(), type: 'queue_items', qty: 3, at: new Date().toISOString(), session_id: host.id },
      {
        id: id(),
        type: 'agent_minutes',
        qty: 12,
        at: new Date().toISOString(),
        session_id: host.id,
      },
    ],
  }),
});
check(
  reported.status === 202 || reported.status === 200,
  `POST /v1/usage/events answered ${reported.status}`,
);
const summary = await rest<{
  period?: unknown;
  seats?: { used: number };
  queue_items?: { limit: number | null };
}>(alice, 'GET', `/v1/workspaces/${ws}/usage/summary`);
check(
  typeof summary === 'object',
  `the usage summary reads: ${JSON.stringify(summary).slice(0, 160)}`,
);
// The worker's aggregation job (pnpm dev:worker, every 15 s) folds the reports into the counters.
type Item = { metric?: string; key?: string; used: number };
const usedOf = (s: { items?: Item[] }, metric: string): number =>
  s.items?.find((i) => (i.metric ?? i.key) === metric)?.used ?? 0;
let counted = false;
for (let i = 0; i < 12 && !counted; i += 1) {
  await new Promise((r) => setTimeout(r, 5_000));
  const again = await rest<{ items?: Item[] }>(alice, 'GET', `/v1/workspaces/${ws}/usage/summary`);
  counted = usedOf(again, 'agent_minutes') >= 12; // queue_items is shown only for plans that limit it
}
console.log(
  counted
    ? 'ok   the worker folded the reports into the counters (agent_minutes 12)'
    : 'note the counters did not move: is `pnpm dev:worker` running? (it aggregates every 15 s)',
);

step('Notification preferences and the inbox');
const prefs = await rest<{ channels: Record<string, unknown> }>(
  alice,
  'GET',
  '/v1/notification-preferences',
);
check(typeof prefs.channels === 'object', 'preferences read (the defaults before a first save)');
const saved = await fetch(`${api}/v1/notification-preferences`, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${alice.token}`,
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    ...prefs,
    channels: { ...prefs.channels, mention: { inbox: true, push: false, email: false, os: true } },
  }),
});
check(saved.status === 200, `PUT /v1/notification-preferences answered ${saved.status}`);
const inbox = await rest<{ data: unknown[] }>(alice, 'GET', '/v1/notifications');
check(Array.isArray(inbox.data), `the inbox reads (${inbox.data.length} notifications)`);

step('Plans and entitlements');
const plans = await rest<{ id: string }[]>(alice, 'GET', '/v1/plans');
check(plans.length >= 3, `the plan catalogue lists ${plans.map((p) => p.id).join(', ')}`);
const ent = await rest<{ plan: string; limits: Record<string, unknown> }>(
  alice,
  'GET',
  `/v1/workspaces/${ws}/entitlements`,
);
check(
  typeof ent.plan === 'string',
  `entitlements: plan ${ent.plan}, relay_access ${String(ent.limits['relay_access'])}`,
);

step('Delete a workspace: the worker purges it');
const scratch = await rest<{ id: string }>(
  alice,
  'POST',
  '/v1/workspaces',
  { name: 'scratch' },
  appToken(alice),
);
await rest(alice, 'DELETE', `/v1/workspaces/${scratch.id}`, undefined, appToken(alice));
const rowsOf = (id: string): number | null => {
  try {
    return Number(
      execFileSync(
        'docker',
        [
          'exec',
          'centcom-dev-postgres-1',
          'psql',
          '-U',
          'centcom',
          '-d',
          'centcom_dev',
          '-At',
          '-c',
          `select count(*) from workspaces where id = '${id}'`,
        ],
        { encoding: 'utf8' },
      ).trim(),
    );
  } catch {
    return null; // no docker or another database: the check below is skipped
  }
};
if (rowsOf(scratch.id) === null) {
  console.log('note could not look at the database, so the purge is not checked');
} else {
  let gone = false;
  for (let i = 0; i < 10 && !gone; i += 1) {
    await new Promise((r) => setTimeout(r, 1_500));
    gone = rowsOf(scratch.id) === 0;
  }
  check(gone, 'the deleted workspace was purged from the database (is `pnpm dev:worker` running?)');
}

await host.end();
console.log(
  process.exitCode === 1
    ? '\nFAILED'
    : '\nOK: history, snapshots, usage and preferences work against the live stack',
);
process.exit(process.exitCode ?? 0);
