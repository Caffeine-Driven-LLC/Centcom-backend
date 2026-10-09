# Invoices (B077)

`GET /v1/workspaces/{id}/invoices` lists a workspace's invoices from a local mirror of its
Stripe invoices ([CT-API-BILLING](../../contracts/02-rest-api.md) `listInvoices`). The mirror is
cheap to page and keeps answering while Stripe is down. Stripe keeps the invoices themselves, the
card, the billing address and the tax ids; the receipts are Stripe's hosted invoice page and PDF,
linked and never fetched, proxied or stored.

Code: `apps/api/src/modules/billing/invoices/` (see its README) and
`apps/api/src/routes/billing-invoices.ts`. Tables: migration
`packages/db/migrations/20260102003700_invoices.sql`.

## The endpoint

- **Who:** scope `billing:read`; the workspace's owner, admins and billing members (B021 RBAC
  `billing.read`, CT-RBAC's "View billing, invoices" row). Members and guests get 403
  `forbidden` (B021 audits the refusal as `permission.denied`, CT-RBAC rule 6); anyone else, and
  an unknown or malformed id, 404 `not_found`. An API key needs `billing:read` and its own
  workspace. A read writes no audit event.
- **Paging:** CT-PAGE. `limit` 1 to 200 (default 50), `cursor` from `next_cursor`; newest first
  (`created_at`, then id). Cursors are bound to the workspace (the list's only filter) and last
  24 h: another workspace's cursor, an expired, forged or malformed one is a 400
  `cursor_invalid` (problem+json).
- **Shape:** the contract's `InvoicePage` of `Invoice`: `id` (opaque: a bare ULID, as CT-IDS
  defines no invoice prefix), `number`, `status`, `amount_due` and `amount_paid` as `Money`
  (integer minor units, `USD` or `EUR`), `period_start`/`period_end` (the service period of the
  invoice's lines), `created_at`, `hosted_invoice_url` and `pdf_url`. Fields Stripe has not set
  yet (a draft's number and links) are left out. Never a Stripe id, a customer id, a payment id,
  card data, the customer's name, address or e-mail, or any other part of the Stripe object.
- **Headers:** `RateLimit-*` and `X-Request-Id` (the API's plugins), and
  `Cache-Control: private, no-store`: the hosted links open the invoice page, so the answer is
  not kept on disk.

### Readings of the contract

| Question                       | Reading                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| May admins list invoices?      | Yes. CT-RBAC's matrix ("View billing, invoices": owner, admin, billing), `02-rest-api.md` (owner/admin/billing) and the 1.1.0 changelog ("invoices readable by owner/admin/billing") agree; only openapi's `x-role: owner/billing` annotation leaves admins out. The RBAC engine is the one authority (GUIDELINES §5.1), so the route asks it for `billing.read`, like B070's subscription. |
| A Stripe status the enum lacks | `Invoice.status` has no `other`, so such an invoice is stored as `other` (with a warning) and never listed, rather than sent with a status the contract lacks or shown as something it is not.                                                                                                                                                                                              |
| Tax                            | The contract's `Invoice` has no tax field, and GUIDELINES §2.3 forbids sending fields not in the schema. The mirror keeps the tax amount and the tax rate summary so a later contract version can show them; Stripe's hosted invoice and PDF carry the full tax detail today.                                                                                                               |
| Which amount                   | The contract has `amount_due` and `amount_paid`; both are shown.                                                                                                                                                                                                                                                                                                                            |

## The mirror

Table `invoices`: one row per Stripe invoice: money as integer minor units with an ISO 4217
currency, the tax amount, the tax rate summary, status, period, creation and payment times, and
the two links.

- **Tax rate summary** (`tax_rates`, JSON): per tax line (at most 20; the amount always sums them
  all), its amount and taxable amount (minor units), whether it is inclusive, Stripe's
  taxability reason (`standard_rated`, `reverse_charge`, …) and the effective rate in basis
  points (integer arithmetic). Read from `total_taxes` (API 2025-03-31.basil) or
  `total_tax_amounts` (older versions). Never a tax-rate id.

A row is written only by the **update rule**:

1. a higher status always wins: Stripe only moves an invoice forward (draft, then open, then
   uncollectible, then paid or void, which are final), so a paid invoice never goes back to open,
   whatever the update claims;
2. the same status is replaced only by a version that is not older and changes something (a
   replay leaves the row, and its `updated_at`, alone). The version is the newest of the
   invoice's `created`, its status transitions (`finalized_at`, `paid_at`, `voided_at`,
   `marked_uncollectible_at`) and when the state was read: the reporting event's `created`, or
   the time a sync or a retrieve read it (a snapshot is as new as its read);
3. a lower or sideways status never replaces; the stored version becomes the newer of the two.

The rule runs inside the upsert's `ON CONFLICT … WHERE`, so concurrent writers (a webhook and two
syncs) cannot move an invoice back. An invoice keeps its public id and its workspace, and every
statement names the workspace (`WHERE workspace_id = $1`, or for the upsert the row and its
conflict guard), on top of the route's RBAC check.

Invoices in a currency other than USD or EUR are never stored (CT-IDS v1 currencies) and are
counted in `invoices_unsupported_currency_total`. A status Stripe adds later is stored as `other`
and not listed (see above).

### Lazy sync

When a list finds the workspace's last sync attempt older than **5 minutes**, it starts one sync:

- single-flight per workspace in the process, and claimed in `invoice_syncs` so concurrent API
  processes share it: Stripe is called **at most once per workspace per 5 minutes**;
- one Stripe call: the customer's newest **100** invoices (`GET /v1/invoices?customer=…`), stored
  by the update rule as of the time they were read; drafts Stripe no longer lists (deleted) are
  dropped within the window that page covers (strictly newer than its oldest invoice), except
  drafts written after the call began (a webhook's new draft), and nothing is dropped when any
  invoice on the page could not be read;
- **never waiting on Stripe for a synced mirror:** a workspace that was synced before is answered
  at once from the mirror while the sync runs in the background. Only a workspace's first sync is
  waited for, at most **2 s**, so a first visit does not list nothing; after that the list
  answers from the mirror as it is and the sync finishes in the background;
- if Stripe fails (429 or 5xx after B070's client retried, or a refusal), the list still answers
  200 from the mirror, a warning `invoice.sync_failed` is logged and
  `invoice_sync_failed_total{reason}` counted. The next attempt waits out the interval.

A workspace without a Stripe customer, or an API without `STRIPE_SECRET_KEY` (billing off), never
calls Stripe.

**The window is the newest 100 invoices.** Until B072's handler feeds the mirror (below), an
invoice older than a workspace's newest 100 is never mirrored. That is more than eight years of
monthly invoices; a backfill (one more page per interval with `starting_after`) is a follow-up if
a workspace ever needs it.

### Webhook path (for B072)

B072's handler stores only a reduced copy of each event and re-fetches what it acts on. The
mirror offers one call per event:

```ts
// apps/api/src/modules/billing/webhooks/handlers.ts: add these types to HANDLED_TYPES and give
// HandlerDeps an `invoices: Pick<InvoiceService, 'refreshInvoice' | 'removeInvoice'>`.
case 'invoice.created':
case 'invoice.finalized':
case 'invoice.updated':
case 'invoice.paid': // as well as its outbox row
case 'invoice.payment_failed': // as well as its outbox rows
case 'invoice.voided':
case 'invoice.marked_uncollectible': {
  const id = str(event.object['id']);
  if (id !== null) await deps.invoices.refreshInvoice(id); // retrieve, store as of the read
  return 'processed';
}
case 'invoice.deleted': // Stripe deletes only drafts
  await deps.invoices.removeInvoice(event.object); // the reduced object's id and customer
  return 'processed';
```

- `refreshInvoice(id)` retrieves the invoice (`StripeClient.retrieveInvoice`) and stores it with
  the read time as its version; `applyInvoiceEvent(invoice, readAt?)` stores an invoice object
  already in hand.
- An invoice of a customer no workspace has throws B070's `BillingStateError('unknown_workspace')`
  after an error log (`invoice.unknown_customer`, with the invoice id, never the customer id). B072's
  processor treats that as a permanent failure: the event is recorded `failed` with
  `unknown_customer`, is not retried and is replayable with `replayEvent` once the link exists
  (the same treatment B070/B072 give a subscription of an unknown customer; B072's
  `stripe.event.dlq` queue is for retries that ran out). No row is created.
- An object that is not an invoice throws a `StripeError('invalid_response')`, and a Stripe outage
  a `StripeError('unavailable')`; B072 retries those and dead-letters them when its retries run
  out.

## Configuration

Nothing new: the mirror uses B070's Stripe configuration (`STRIPE_SECRET_KEY`, `STRIPE_API_BASE`,
`STRIPE_API_VERSION`) and B025's `CURSOR_SIGNING_KEYS`. Its constants (in `service.ts` and
`stripe-invoice.ts`):

| Constant                    | Default | What                                                          |
| --------------------------- | ------- | ------------------------------------------------------------- |
| `SYNC_INTERVAL_MS`          | 300 000 | How long the mirror is fresh; at most one sync per it.        |
| `SYNC_WAIT_MS`              | 2 000   | How long a list waits for a first sync (`syncWaitMs`).        |
| `SYNC_PAGE_SIZE`            | 100     | Invoices one sync reads (one Stripe call).                    |
| `MAX_REMEMBERED_WORKSPACES` | 10 000  | Workspaces a process remembers the next sync time for.        |
| `MAX_TAX_LINES`             | 20      | Tax lines kept in the summary (the amount sums them all).     |
| `MAX_LINK_LENGTH`           | 2 048   | The longest hosted link kept (https only, else none is kept). |

## Failure modes

| What                                              | What happens                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Stripe unreachable or failing during a sync       | The mirror is served, 200; `invoice.sync_failed` warning; `invoice_sync_failed_total{reason}`.                    |
| Stripe slow                                       | A synced mirror is served at once; a first sync is waited for at most 2 s; the sync finishes in the background.   |
| Invoice of an unknown customer (webhook)          | Dropped with an error log; `BillingStateError` makes B072 record the event `failed` (`unknown_customer`); no row. |
| Invoice in another currency                       | Not stored; `invoices_unsupported_currency_total{source}`.                                                        |
| Unknown Stripe status                             | Stored as `other`, not listed; `invoice.unknown_status` warning.                                                  |
| Cursor invalid, expired or from another workspace | 400 `cursor_invalid`, problem+json (CT-PAGE).                                                                     |
| Database unavailable                              | The list fails as the API does for any database error.                                                            |

## Metrics

| Metric                                        | What                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `invoice_events_total{outcome}`               | Invoices handed to `applyInvoiceEvent`: written, unchanged, unsupported_currency, unknown_customer. |
| `invoice_syncs_total`                         | Syncs that read Stripe and completed.                                                               |
| `invoice_sync_failed_total{reason}`           | Syncs that failed: stripe_unavailable, stripe_error, error.                                         |
| `invoices_unsupported_currency_total{source}` | Invoices not mirrored for their currency, from an event or a sync.                                  |

Request rate, errors and latency of the endpoint come from the API's HTTP metrics (B093).

## Privacy and retention

The mirror holds no card data, customer id, name, address, e-mail, payment id or tax-rate id.
Logs never carry a customer id, a link or an amount. The hosted invoice URL grants access to the
invoice page, so it is shown only to the roles above, never logged, and the answer is not cached
(`no-store`). Rows live as long as their workspace (B027's purge deletes them with it);
`invoice_syncs` likewise.

## How to test

`apps/api/test/billing/invoices/` (fixtures shaped like Stripe test-mode invoices in
`fixtures/`):

- `invoices.mapping`: Stripe to mirror to public, every status, tax present or absent and its
  summary, both currencies, zero totals, the update rule;
- `invoices.apply`: idempotency, out-of-order updates, no regression, higher statuses across
  sources, `refreshInvoice`, `removeInvoice` (reduced objects, workspace scoping), unknown
  customers;
- `invoices.authz`: the five roles, other workspaces, API keys, scopes, audit;
- `invoices.pagination`: the cursor walk, ties, cursors bound to the workspace, expiry, limits,
  arrivals between pages;
- `invoices.sync`: the lazy sync, single flight, once per 5 minutes across processes, Stripe
  failures (also over HTTP through B070's client) and stalls, background refreshes, deleted drafts;
- `invoices.contract`: headers, problem+json, `InvoicePage`, privacy;
- `invoices.repository`: every statement's workspace scoping and the guard, on a scripted driver;
- `invoices.stripe-client`: `listInvoices` and `retrieveInvoice` over HTTP, retries;
- `invoices.perf` (with `invoices-bench.ts`, in its own process): p95 of the list over 1 000
  invoices, in memory and (with `DATABASE_URL`) on Postgres;
- `invoices.postgres` (`DATABASE_URL`): the same rules in the repository's SQL.
