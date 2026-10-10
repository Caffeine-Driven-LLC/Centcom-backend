# Session routes (B054)

The REST surface of sessions ([CT-API-SESSIONS](../../../../../contracts/02-rest-api.md),
`contracts/openapi.yaml`): list, create, get, patch, end, join-token, claim-host and members.
The state machine, expiry and outbox of transitions are B053's (`modules/sessions`); slots are
B031's; entitlements B080's; relay tickets B017's. `registerSessionRoutes(app, deps)` adds the
routes.

## Routes

| Route                               | Scope            | Who                                     | Notes                                   |
| ----------------------------------- | ---------------- | --------------------------------------- | --------------------------------------- |
| `GET /v1/sessions`                  | `sessions:read`  | owner, admin, member of `workspace`     | without `workspace`: the caller's own   |
| `POST /v1/sessions`                 | `sessions:host`  | owner, admin, member                    | `Idempotency-Key` accepted; 201, ETag   |
| `GET /v1/sessions/{id}`             | `sessions:read`  | a live member, or owner/admin/member    | ETag                                    |
| `PATCH /v1/sessions/{id}`           | `sessions:host`  | the host                                | `{name?, policy?}`; `If-Match` optional |
| `POST /v1/sessions/{id}/end`        | `sessions:host`  | the host, or a workspace owner or admin | ending an ended session returns it      |
| `POST /v1/sessions/{id}/join-token` | `sessions:write` | a live member, or who may join          | 60 s single-use relay ticket            |
| `POST /v1/sessions/{id}/claim-host` | `sessions:host`  | a workspace owner or admin              | only while the host is not connected    |
| `GET /v1/sessions/{id}/members`     | `sessions:read`  | a live member                           | join order, slots, device public keys   |

- **Users only.** An API key is 403 on every route: keys are not members, cannot join or host
  (CT-AUTH "API keys"), and B021's matrix gives them no session action.
- **404, not 403,** for a session the caller may not see (not a live member, and a workspace role
  that may not join), and for the members list to anyone but a live member. A workspace the caller
  is not in: create 404 `workspace_not_found`, list 403 (`listSessions` declares no 404). Join-token answers a
  member of the workspace whose role may not join (billing, a guest not in the session) with 403.
- **Roles** are read from the records (B021's authorizer, the session member rows), never from
  token claims. A member's role is capped by their workspace role as the relay caps it: a guest
  is at most `viewer`, `billing` none.
- **Join:** a first join-token makes the caller a member (`editor`; B021 `session.join.editor`),
  unless the host locked the session (`session_locked`), the plan has no relay
  (`entitlement_required`), the session has `max_session_members` live members
  (`member_limit_reached`) or B031 has no slot (`session_full`). A member removed by the host
  (B051's kick) is 403 `not_a_member`. Guests join only when invited, and no session invite
  exists yet.
- **Tickets:** `{sid, mid, role, dev, caps}`, `aud` `centcom-relay`, 60 s, a fresh `jti`, signed by
  B017. The `jti` is recorded for 60 s under `ticket:issued:{jti}`; the relay refuses a second use
  with its own `relay:jti:{jti}` (B038), which the API must not write first. Tickets are never
  logged or put in a URL.
- **claim-host:** one transaction: every other live host row `editor` (a relay-side transfer moves
  the role, not `host_member_id`), caller `host`, `sessions.host_member_id` moves (with a fresh
  10 min grace to connect), one `control.transfer_host` audit event, and a `session_host_outbox`
  row. B053's service has no host-change method, so the store writes `host_member_id`,
  `host_connected`, `last_host_seen_at` and `updated_at` itself. A refused or failed claim
  removes the membership it added for the admin. After the commit the row goes to the relay as `control.host_changed`
  (`code: failover`, the current host). A failure keeps it queued; `deliverHostChanges(deps, now)`
  retries it (5 s, doubling, at most every 10 min). Today only the next claim on the session calls
  it; a periodic sweep in the worker is wiring for a later lane.
- **ETag:** a strong tag over the name, state, host, region, end time and policy. PATCH's host
  check, `If-Match` compare, writes (name; B051's `session_policy`) and `control.policy` audit
  event are one transaction with the session's row locked (`store.patchSession`), on one
  connection. Refusals of non-hosts (PATCH, end) are audited `permission.denied`.

## Dependencies (`SessionRouteDeps`)

| Field          | What                                                             |
| -------------- | ---------------------------------------------------------------- |
| `service`      | B053's `SessionService` (create, get, list, rename, policy, end) |
| `store`        | `createSessionRouteStore(db)` (`store.ts`)                       |
| `slots`        | B031's `createSessionSlotStore(db)`                              |
| `entitlements` | B080's enforcer (`check`)                                        |
| `tickets`      | B017's `TokenService` (`mintRelayTicket`)                        |
| `issued`       | a `KeyValue` for the `jti` records (B009)                        |
| `hostNotifier` | sends `control.host_changed` to the relay                        |
| `relays`       | `{defaultRegion, urls: {region: wss URL}}`                       |
| `cursorKeys`   | CURSOR_SIGNING_KEYS (B025), for the members list                 |

Register after the request-context, error-handler, rate-limit, auth, idempotency, RBAC and audit
plugins.

## Stores

Migration `20260102004400_session_host_outbox.sql`: `session_host_outbox`, the queued host
changes (deleted once delivered; cascades from its session).

## Metrics

- `session_ticket_failures_total{reason}`: `signing` (the key is unavailable: 503 with
  `retry_after_s`) or `record` (the `jti` could not be recorded: 503).
- `session_host_outbox_failed_total`: host changes the relay notifier refused (rescheduled).

## Failure modes

- B053's state machine refusing a transition (`SessionStateError`): 409 `conflict`, nothing
  changed.
- Signing key unavailable: 503, `retry_after_s` 5, no ticket, the counter above.
- Entitlements unreadable: 503, no member row (create: B053's 503).
- Relay notifier down during claim-host: the claim commits, the notification stays queued, 200.

## Testing

`apps/api/test/routes/sessions/` (in memory, with B053's real service and B017's real token
service; `sessions.postgres.test.ts` on Postgres 16 through DATABASE_URL):

- `sessions.routes.authz`: the scope x role matrix, API keys, 404 vs 403.
- `sessions.join-token`: claims, lifetime, `jti` records, membership, plan limits, failures.
- `sessions.idempotency`: replay and conflict; no row on an entitlement refusal.
- `sessions.claim-host`: admin only, host connected, audit, notifier down.
- `sessions.patch`: If-Match, editors, names, state conflicts, end.
- `sessions.contract`: bodies against the generated schemas, headers, members' keys.
- `sessions.pagination`: limits, stable pages, filters, cursors, join order.
