/**
 * Times `GET /v1/workspaces/{id}/invoices` over 1 000 invoices with a fresh mirror (B077
 * acceptance 6: p95 <= 80 ms, mirror hit, no Stripe call). invoices.perf.test.ts runs this in a
 * separate Node process (tsx's CLI with tsconfig.test.json, so no build is needed): test workers
 * run under coverage instrumentation and share their thread with other test files.
 *
 * Input (stdin, JSON): `{ mode: 'memory' | 'postgres', rows }`. Postgres mode (DATABASE_URL,
 * CI's integration job) keeps the mirror in a migrated throwaway database. After a warm-up, three
 * rounds of 100 first pages and 100 pages deep in the list (default limit 50); writes
 * `{ p95s, stripeCalls, listed }` (milliseconds, one per round) as JSON to stdout.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { InvoicesDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import {
  createInvoiceRepository,
  newInvoiceId,
  type InvoiceRow,
} from '../../../src/modules/billing/invoices/repository.js';
import { SYNC_INTERVAL_MS } from '../../../src/modules/billing/invoices/service.js';
import { asUser } from '../../modules/workspaces/helpers.js';
import { migratedDatabase, type TestDatabase } from '../../modules/users/helpers.js';
import { invoicesApp, memoryInvoices, newId, READ, stripeId } from './helpers.js';

const ROUNDS = 3;
const PER_ROUND = 100;

const input = JSON.parse(readFileSync(0, 'utf8')) as { mode: 'memory' | 'postgres'; rows: number };
const now = Date.UTC(2026, 9, 9, 12, 0, 0);
let database: TestDatabase | null = null;
const mirror = memoryInvoices();
if (input.mode === 'postgres') {
  database = await migratedDatabase(5);
  const repository = createInvoiceRepository(database.db as unknown as Kysely<InvoicesDb>);
  Object.assign(mirror.repository, repository);
}

const t = await invoicesApp({ clock: () => now, mirror });
const owner = newId('usr');
t.store.addUser(owner);
const created = await t.app.inject({
  method: 'POST',
  url: '/v1/workspaces',
  headers: asUser(owner),
  payload: { name: 'Bench' },
});
const ws = String(created.json<{ id: string }>().id);
if (database !== null) {
  // The workspace the in-memory store made, mirrored in Postgres for the foreign keys.
  const db = database.db;
  await db
    .insertInto('users')
    .values({ id: owner, email: `${owner.toLowerCase()}@example.test`, display_name: 'Bench' })
    .execute();
  await db
    .insertInto('workspaces')
    .values({
      id: ws,
      name: 'Bench',
      slug: `bench-${ws.slice(-8).toLowerCase()}`,
      created_by: owner,
    })
    .execute();
}
const customer = stripeId('cus');
t.billing.customers.set(ws, customer);

// 1 000 paid invoices an hour apart, written in batches.
const start = Date.UTC(2025, 0, 1) / 1000;
const rows: InvoiceRow[] = Array.from({ length: input.rows }, (_, i) => ({
  id: newInvoiceId(),
  workspaceId: ws,
  stripeInvoiceId: stripeId('in'),
  number: `B-${String(i).padStart(5, '0')}`,
  status: 'paid',
  currency: 'EUR',
  amountDue: 7900 + i,
  amountPaid: 7900 + i,
  tax: 1501,
  taxRates: [
    {
      amount: 1501,
      taxable_amount: 7900,
      inclusive: false,
      reason: 'standard_rated',
      rate_bps: 1900,
    },
  ],
  periodStart: new Date((start + i * 3600) * 1000),
  periodEnd: new Date((start + i * 3600 + 2_592_000) * 1000),
  createdAt: new Date((start + i * 3600) * 1000),
  paidAt: new Date((start + i * 3600 + 60) * 1000),
  hostedUrl: `https://invoice.stripe.com/i/acct_Bench/test_${i}`,
  pdfUrl: `https://pay.stripe.com/invoice/acct_Bench/test_${i}/pdf`,
  version: start + i * 3600 + 60,
}));
for (let i = 0; i < rows.length; i += 200) {
  await mirror.repository.upsert(rows.slice(i, i + 200), new Date(now));
}
// A fresh mirror: the last sync attempt was just now.
await mirror.repository.claimSync(ws, new Date(now), SYNC_INTERVAL_MS);

const url = `/v1/workspaces/${ws}/invoices`;
const headers = asUser(owner, READ);
const first = await t.app.inject({ method: 'GET', url: `${url}?limit=200`, headers });
// A cursor 400 invoices in, for the deep pages.
let deep = first.json<{ next_cursor: string }>().next_cursor;
const second = await t.app.inject({
  method: 'GET',
  url: `${url}?limit=200&cursor=${deep}`,
  headers,
});
deep = second.json<{ next_cursor: string }>().next_cursor;
const deepUrl = `${url}?cursor=${deep}`;

const get = async (target: string): Promise<number> => {
  const started = performance.now();
  const res = await t.app.inject({ method: 'GET', url: target, headers });
  const elapsed = performance.now() - started;
  if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
  return elapsed;
};
for (let i = 0; i < 30; i += 1) await get(i % 2 === 0 ? url : deepUrl);

const p95s: number[] = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const samples: number[] = [];
  for (let i = 0; i < PER_ROUND; i += 1) {
    samples.push(await get(url));
    samples.push(await get(deepUrl));
  }
  samples.sort((a, b) => a - b);
  p95s.push(samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY);
}
const listed = (await t.app.inject({ method: 'GET', url: `${url}?limit=1`, headers })).json<{
  data: unknown[];
}>().data.length;
await t.app.close();
await database?.drop();
process.stdout.write(JSON.stringify({ p95s, stripeCalls: t.stripe.listCalls.length, listed }));
