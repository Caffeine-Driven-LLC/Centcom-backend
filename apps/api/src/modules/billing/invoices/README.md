# Invoices (B077)

The invoice mirror behind `GET /v1/workspaces/{id}/invoices` (CT-API-BILLING `listInvoices`): a
local copy of each workspace's Stripe invoices, cheap to page and served while Stripe is down.
The full description (contract readings, the update rule, the lazy sync, failure modes, metrics)
is [`docs/billing/invoices.md`](../../../../../../docs/billing/invoices.md).

## Pieces

| File                | What it does                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe-invoice.ts` | `parseStripeInvoice` (a Stripe invoice object to what the mirror keeps), status mapping, the update rule.                                    |
| `repository.ts`     | `createInvoiceRepository`: the guarded upsert, the keyset list, draft removal, the sync claim (Postgres).                                    |
| `service.ts`        | `InvoiceService`: `applyInvoiceEvent`, `refreshInvoice`, `removeInvoice`, `syncInvoices`, `refreshIfStale`, `list`, `idle`; `publicInvoice`. |
| `ports.ts`          | `InvoiceStripe` (B070's `StripeClient.listInvoices`/`retrieveInvoice`) and `CustomerLinks` (B070's repository).                              |
| `index.ts`          | The module's exports.                                                                                                                        |

Route: `routes/billing-invoices.ts` (`invoiceRoutes`). Tables: `invoices` and `invoice_syncs`
(migration `20260102003700_invoices.sql`, types in `@centcom/db`'s `schema/invoices.ts`).

## Public interface

- `InvoiceService.list(workspaceId, page)`: a CT-PAGE page of the contract's `Invoice`, after a
  lazy sync (`refreshIfStale`: at most once per workspace per 5 minutes; only a first sync is
  waited for).
- `InvoiceService.refreshInvoice(id)`: retrieves one invoice and stores it as of the read; the one
  call B072's handler needs per `invoice.*` event.
- `InvoiceService.applyInvoiceEvent(invoice, readAt?)`: stores one Stripe invoice object (checked
  here) by the update rule.
- `InvoiceService.removeInvoice(invoice)`: drops a deleted draft (B072's `invoice.deleted`; its
  reduced object will do), in the customer's workspace only.
- `InvoiceService.syncInvoices(workspaceId)`: reads the newest 100 invoices from Stripe, returns
  `{ upserted }`; `idle()` resolves when this process's syncs are done (tests, shutdown).

## Wiring

```ts
const invoices = new InvoiceService({
  repository: createInvoiceRepository(db),
  stripe: stripeConfig === null ? null : stripeClient, // B070's StripeClient
  customers: createBillingRepository(db), // B070
  logger,
  metrics,
});
await app.register(invoiceRoutes, { invoices, cursorKeys: paginationConfig().signingKeys });
// After the request-context, error-handler, auth, rate-limit and RBAC plugins.
```

B072's handler calls `refreshInvoice` and `removeInvoice`; the snippet is in the doc.

## Tests

`apps/api/test/billing/invoices/` (see the doc's "How to test").
