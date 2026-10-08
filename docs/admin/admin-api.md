# Internal admin API

Lane B087. A small API for Centcom staff doing support: look up users, workspaces and sessions
(metadata only), revoke access, and manage feature flags and status incidents. Every call is
audited, reads included. It cannot read session content, history, snapshots, keys or messages,
and it cannot act as a user: there is no impersonation, by design.

## Where it runs

The admin API has its own listener, never the public API's port:

| Key                   | Default  | Meaning                                                         |
| --------------------- | -------- | --------------------------------------------------------------- |
| `ADMIN_API_ENABLED`   | `false`  | Starts the admin listener. Off: the admin API does not exist.   |
| `ADMIN_API_PORT`      | `8081`   | Its port.                                                       |
| `ADMIN_ALLOWED_CIDRS` | _(none)_ | Comma-separated CIDR blocks it accepts; required when it is on. |

- Routes live under `/internal/admin/v1`, on that listener only. The public listener has none
  (`404`), and the admin listener serves nothing else.
- A connection from an address outside `ADMIN_ALLOWED_CIDRS` is dropped as it opens, before any
  request is read. `X-Forwarded-For` is never consulted: put the listener on the private network,
  not behind the public load balancer.
- Metrics: `admin_calls_total{outcome}`, `admin_audit_failures_total`,
  `admin_connections_refused_total`.

## Who may call it

Every call needs all of:

1. `Authorization: Bearer <access token>`: a user's token (not an API key, not a relay ticket)
   with the scope `admin`;
2. an enabled row in `staff_users` for that user. The row is read on every call, cached at most
   5 seconds, so a removed staff member is refused within 5 s;
3. `X-Admin-Reason`: why, 10 to 500 characters. Optionally `X-Admin-Ticket`: a ticket reference,
   1 to 64 characters of `A-Z a-z 0-9 . _ # : / -`;
4. at most 60 calls a minute per staff member;
5. a role high enough for the route.

| Role         | May                                                            |
| ------------ | -------------------------------------------------------------- |
| `support_ro` | read; sees e-mail addresses masked (`a***@e***.com`)           |
| `support_rw` | read and write; acting on an active staff member's account: no |
| `superadmin` | everything, including staff records (never their own)          |

Refusals: no or bad token `401` (`unauthorized`, `token_expired`, `token_invalid`,
`token_revoked`, `device_revoked`); not staff, disabled, or role too low `403 forbidden`; reason
or ticket missing or invalid `422 validation_failed`; over the rate `429 rate_limited` with
`Retry-After`. A header naming a workspace or a user to act as (`X-Centcom-Workspace`, `X-Act-As`,
`X-Impersonate-…`, `X-On-Behalf-Of`, `X-Forwarded-User`, …) or a query parameter the route does not
take: `400 invalid_request`.

### The first superadmin

Staff rows are added through the API by a superadmin. The first one is inserted by an operator:

```sql
insert into staff_users (user_id, role) values ('usr_…', 'superadmin');
```

## Routes

All under `/internal/admin/v1`. Bodies are JSON; the types are in
`apps/api/src/modules/admin/types.ts`.

| Route                              | Least role   | Does                                                                    |
| ---------------------------------- | ------------ | ----------------------------------------------------------------------- |
| `GET /users/{id}`                  | `support_ro` | The user, their devices (no keys) and memberships                       |
| `GET /users?email=`                | `support_ro` | The user with that address (ignoring case), if any                      |
| `GET /workspaces/{id}`             | `support_ro` | Members and roles (first 200), plan, subscription status, limits, usage |
| `GET /sessions/{id}`               | `support_ro` | id, workspace, state, region, times, member count, host member          |
| `GET /staff-audit`                 | `support_ro` | Admin API calls, newest first (`limit`, `cursor`, `actor`, `target`)    |
| `POST /users/{id}/revoke-tokens`   | `support_rw` | Revokes every token of the user, or one device (`{"device": "dev_…"}`)  |
| `POST /users/{id}/disable`         | `support_rw` | Stops the user signing in, and revokes every token                      |
| `POST /sessions/{id}/end`          | `support_rw` | Marks the session ended                                                 |
| `POST /invites/{id}/resend`        | `support_rw` | Re-sends a pending invite                                               |
| `POST /workspaces/{id}/promotions` | `support_rw` | Grants a promotion (`{"promotion_code_id": "…"}`, B079)                 |
| `PUT /flags/{key}`                 | `support_rw` | Sets a feature flag (B083's definition)                                 |
| `DELETE /flags/{key}`              | `support_rw` | Deletes a feature flag                                                  |
| `POST /incidents`                  | `support_rw` | Opens a status incident (`{title, component_ids, status}`, B086)        |
| `POST /incidents/{id}/updates`     | `support_rw` | Adds an update (`{text, status?}`)                                      |
| `PUT /staff/{userId}`              | `superadmin` | Adds a staff member or changes their role (`{"role": …}`)               |
| `DELETE /staff/{userId}`           | `superadmin` | Disables a staff member                                                 |

Revoking tokens: the user's next refresh answers `401 token_revoked`, their access tokens stop
working at once, and the revocation is announced on Redis `centcom:auth-revocations` so the relay
can close their sockets (`4401`). Disabling also makes every sign-in and refresh answer
`403 access_denied` while it lasts.

What responses never hold: session names or content, messages, snapshots, key bundles, device
keys, token or key hashes, tokens, API key or webhook secrets, Stripe ids (beyond a masked tail),
or payment data. Bodies are built from allowlisted fields, then scrubbed of any field or value that
looks like a credential.

## Audit

Every call writes exactly one audit event, `staff.access`, whatever its outcome:

- actor: `staff` (`usr_` id) for staff; `user` for a valid token that is not staff's; `system`
  `admin-api` for a call without a usable credential;
- target: the user, workspace, session, invite, incident or staff record (a flag's key is in
  `meta.flag`);
- outcome: `success`, `denied` (a refusal: 401, 403, 429, or a request refused before any work)
  or `failed` (the work failed: a missing target is `404` and `failed`);
- meta: method, route template (never the URL), status, error code, role, flag;
- reason and ticket, in `staff_audit_details` beside the event (free text cannot go in meta).

The event is written before the response leaves. A read is answered, then recorded; if that fails
the body is withheld and the call answers `503`. A write records its event first, in a transaction
that commits only if the action succeeds; if the event cannot be written, nothing is done (`503`).
`POST /incidents` records its event right after creating the incident, in that same transaction, so
the event names it. Staff events have no workspace: they never show in a customer's audit log.

Flag changes are also audited by B083 as `flag.set` / `flag.delete`, with the staff member's id.

## Failures

| What                                                        | Answer                                    |
| ----------------------------------------------------------- | ----------------------------------------- |
| Audit store (Postgres) down                                 | `503`, no data, nothing done              |
| Staff table or Redis rate limit down                        | `503`                                     |
| A service behind a route down (flags, status, entitlements) | `502 bad_gateway`, event `failed`         |
| Invite resend or promotions not wired                       | `503 service_unavailable`, event `failed` |
| Target not found                                            | `404`, event `failed`                     |

## Wiring

```ts
const store = createAdminStore({
  db,
  emitter: createAuditEmitter({ db, actions: ADMIN_AUDIT_ACTIONS }),
});
const directory = new StaffDirectory({ reader: store.reader });
const tokens = new TokenService({ ...deps, signInGate: createLoginGate(db) });
await startAdminServer(loadAdminConfig(), {
  store,
  access: { tokens, directory, rateLimit: redis.rateLimit },
  service: new AdminService({
    store,
    tokens,
    directory,
    flags: flagAdmin,
    status: statusAdmin,
    entitlements,
    cursorKeys,
    pubsub: redis.pubsub,
    logger,
    // invites, promotions: once B029 has a resend and B079 is built
  }),
  logger,
  metrics,
});
```

B089 mounts its search routes on this listener with `requireStaff(minRole)` as their preHandler.

## Not here

The admin console (B088), metadata search (B089), impersonation (never), billing changes beyond
promotion grants (the Stripe dashboard), and the public audit API (B082).
