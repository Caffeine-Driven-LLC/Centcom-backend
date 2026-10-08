# Seats (B030)

Counts a workspace's seats and enforces `limits.max_seats`
([CT-ENTITLEMENTS](../../../../../contracts/07-billing-entitlements.md)) when a member is added:
an invite created or accepted (B029).

## What counts

- **Members:** memberships whose role is in `SEAT_COUNTED_ROLES`, which is `owner`, `admin` and
  `member` (CT-ENTITLEMENTS "Seats"). `guest` and `billing` take no seat. This constant is the
  only place that decides it.
- **Pending invites:** for those roles, not accepted, revoked or expired, with `expires_at` after
  the service's clock (they stop counting at that instant). A deleted workspace's invites never
  count.
- `usage(workspaceId, trx?)` gives `{members, pending_invites, total}` in one statement, on the
  caller's transaction when given. `getSeatUsage` is the read-only summary for billing (B073).
  `withSeatUsage(seats, reader)` adds `usage.seats` (the members' seats) to B069's usage reader.

## The gate

`createSeatGate({seats, limits, metrics?, logger?})` implements B029's `SeatGate`, and
`seatGatePlugin` registers it as the `seatGate` decorator. B029's invite routes refuse to start
without it. `assertCanAdd(trx, workspaceId)` runs in the transaction that adds the member:

1. It reads `max_seats` through `seatLimitsFrom(entitlementService)`. A reader failure is a 503
   (retryable), so the gate fails closed and is never unlimited. A workspace with no entitlements
   is 403 `entitlement_required`.
2. It takes `pg_advisory_xact_lock(hashtext(workspace_id))`, waiting at most 5 s. A longer wait,
   a cancelled statement or a lost connection is a 503 with `Retry-After: 1`. The caller's
   `lock_timeout` is put back afterwards, and the lock is held until the transaction ends.
3. It counts in that transaction. `total >= max_seats` is 403 `seat_limit_reached`, whose detail
   names the limit only. `null` never refuses; `0` always does.

A downgrade that leaves usage above the limit blocks new adds and removes nobody. Refusals are
counted in `seat_gate_rejections_total{reason}`, where `reason` is `limit`,
`entitlements_unavailable`, `no_entitlements` or `lock_timeout`.

## Wiring

```ts
const seats = new SeatService({ db });
await app.register(seatGatePlugin, {
  gate: createSeatGate({ seats, limits: seatLimitsFrom(entitlements), metrics, logger }),
});
// before inviteRoutes (B029); B069: usage: withSeatUsage(seats, usageReader)
```

## Migration

`20260102001600_seat_indexes.sql` adds the partial index
`invites_workspace_id_pending_idx (workspace_id, expires_at)` over pending invites. There is no
separate `memberships (workspace_id)` index: the unique constraint on
`(workspace_id, user_id)` already serves that lookup.

## Tests

`apps/api/test/modules/seats/`: `seats.gate`, `seats.downgrade`, `seats.dependency-failure`,
`seats.usage`, and `seats.postgres` (when `DATABASE_URL` is set: counts, the expiry instant,
20 concurrent adds for one seat, the 5 s lock wait, p95 timing).
