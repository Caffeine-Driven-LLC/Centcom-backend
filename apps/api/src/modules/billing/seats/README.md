# Seat quantity (B073)

`PATCH /v1/workspaces/{id}/seats` (CT-API-BILLING `changeSeats`) changes a Team workspace's seats
on its Stripe subscription; `?preview=true` answers what the change would cost and changes
nothing. A daily job (`billing.seats.reconcile`) makes the stored seats follow Stripe.

## Rules

- **Seats are the total:** Team's 5 included seats plus the add-on seat item's quantity. A change
  sets the add-on quantity to `seats - 5` (added, updated, or removed at 0) with
  `proration_behavior: create_prorations`.
- **Bounds:** 1 to BILLING_MAX_SEATS (default 500, B071's key), else 422 at `/seats`; never below
  the seats in use (B030: members plus pending invites), a 409 `conflict` with
  `errors[0].code = seats_in_use` and no Stripe call; Team never below its 5 (422). Pro, free and
  no subscription are a 409 (`single_seat_plan`); a canceled subscription a 409
  (`subscription_inactive`).
- **Serialised with invites:** the count and the Stripe update run under the workspace's lock: the
  advisory lock B030's gate takes (`hashtext(workspace_id)`), held as a session lock on one pooled
  connection, so no transaction stays open across Stripe. Each try borrows a connection and gives
  it back if the lock is taken, so waiters hold none; it waits at most 5 s, then 503 with
  `Retry-After: 1` (a database that cannot be reached is a 503 too). The stored row is re-read and
  re-checked under the lock. B030's gate reads `max_seats` again once it holds the lock, so an
  invite created during a decrease is checked against the lowered limit: one of them wins.
- **Stripe first:** nothing local changes until Stripe accepted the update. Stripe's idempotency key
  is `centcom-<workspace>-seats-<before>-<target>-<sha256(caller, Idempotency-Key or request id)>`
  (`before`: Stripe's seats when read). The subscription is read first: one that already has the
  target (an answer lost after Stripe applied it) is stored without a second write, and nothing is
  done when Stripe and the stored row both have it. What Stripe returns goes through B070's
  `upsertFromStripe` (stamped with the last stored event's time, so the later webhook still
  applies) to B069, which moves entitlements' `rev`.
- **Failures:** Stripe unreachable is 503 with `retry_after_s` (30); a refusal is 500; B030's
  count unavailable is 503 (never assumed zero); billing off (no Stripe key) is 503. None of them
  changes anything.
- **Preview:** reads the subscription and asks Stripe for an invoice preview of the item change
  prorated from now (`proration_date`): no write anywhere. The proration is the sum of the
  preview's proration lines that start at that instant (an earlier change's proration still
  pending on the upcoming invoice is not this one's), as `Money` in integer minor units.
- **Audit:** a change writes `billing.seats` (`from_seats`, `to_seats`), the name CT-API-AUDIT
  lists.
- **Reconcile:** for every Team workspace with a subscription in effect, in batches of 200 by id:
  Stripe's seats against the stored ones (a drift is stored and logged `billing.seats_drift`) and
  the seats in use (more in use than Stripe sells is logged `billing.seats_over_capacity`). One
  workspace's failure is counted and the run goes on.

## Pieces

| File                                     | What it does                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `service.ts`                             | `SeatService`: `change`, `preview`, `reconcile`; `seatsOf` (Team's seats).         |
| `reconcile.ts`                           | `reconcileAll` and `createReconcileSource` (Team workspaces in effect, by id).     |
| `ports.ts`                               | `SeatAccountingPort` (`seatAccountingFrom(B030)`), `SeatStripe`, `createSeatLock`. |
| `index.ts`                               | The module's exports.                                                              |
| `routes/seats/index.ts`                  | `seatRoutes`: the route, RBAC (`billing.manage`), validation, audit.               |
| worker `jobs/billing-seats-reconcile.ts` | The daily queue, its schedule and worker.                                          |

Changed elsewhere for this lane: B024's idempotency plugin also takes PATCH routes
(`changeSeats` is the contract's only idempotent PATCH), with the query in a PATCH's fingerprint
(a preview and the change are two requests); B030's gate reads `max_seats` again under its lock;
B070's `previewInvoice` sends `proration_date` and returns each line's `periodStart`.

## Wiring

```ts
const seats = new SeatService({
  billingRepository, // B070's createBillingRepository(db)
  billing, // B070's BillingService
  stripe: stripeConfig === null ? null : stripeClient, // B070's StripeClient
  catalog, // B070's price catalogue
  seats: seatAccountingFrom(seatUsage), // B030's SeatService
  lock: createSeatLock(db),
  maxSeats: loadCheckoutConfig().maxSeats, // B071
  logger,
  metrics,
});
await app.register(seatRoutes, { seats });
// After the request-context, error-handler, auth, rate-limit, idempotency, RBAC and audit plugins.

// Worker:
const queue = createBillingSeatsReconcileQueue({ connection });
await scheduleBillingSeatsReconcile(queue);
startBillingSeatsReconcileWorker({
  connection,
  run: () => reconcileAll({ source: createReconcileSource(db), seats, logger, metrics }),
  logger,
  metrics,
});
```

## Metrics

| Metric                                     | Labels                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `billing_seat_changes_total`               | `outcome`: changed, unchanged, previewed, seats_in_use, single_seat_plan, inactive, stripe_failed |
| `billing_seat_reconciles_total`            | `outcome`: in_sync, repaired, drift, failed                                                       |
| `billing_seat_reconcile_runs_failed_total` | none: a run dead-lettered after 3 attempts                                                        |
