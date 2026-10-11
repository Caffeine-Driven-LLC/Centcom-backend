# Share links (B068)

Viewer-only share links: the host creates and revokes short-lived links, and anonymous visitors
exchange a link's token for a limited guest relay ticket
([CT-API-SESSIONS](../../../../../contracts/02-rest-api.md), CT-CRYPTO §4a, CT-RBAC
"Share-link guests"). The routes are `routes/share-links/`.

## Parts

| File                        | What it does                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| `service.ts`                | `ShareLinkService`: create, revoke, join, sweep; limits and uniform refusals. |
| `repository.ts`             | `ShareLinkStore` on Postgres: links by hash, the atomic `consume`, guests.    |
| `guest-ticket.ts`           | Tokens (256 bits, SHA-256 stored) and the guest's relay ticket (B017).        |
| `../../routes/share-links/` | The three routes and `standingOf` (B054's standing, role cap included).       |

## Routes

| Route                                          | Scope           | Who      | Answer                                    |
| ---------------------------------------------- | --------------- | -------- | ----------------------------------------- |
| `POST /v1/sessions/{id}/share-links`           | `sessions:host` | the host | 201 `ShareLink` (+ `max_uses`), once only |
| `DELETE /v1/sessions/{id}/share-links/{token}` | `sessions:host` | the host | 204                                       |
| `POST /v1/share-links/{token}/join`            | public          | anyone   | 200 `JoinToken` (`role: viewer`, no caps) |

## Rules

- **Create** (the host; an editor or viewer is 403 `host_required`, audited; a stranger 404; an
  API key 403):
  - `expires_in_s` is 60 to 86 400, default 3 600. A link never lives past 24 h, and the table
    checks it too.
  - `max_uses` is 1 to 50, default 10. Anything else is 422.
  - An ended session is 410.
  - The token is 32 random bytes in base64url (43 characters), answered once with
    `https://centcom.dev/j/<token>`; the client adds the `#k=` fragment. Only its SHA-256 is
    stored.
  - 20 per minute per user. If the counters fail, creating is let through.
  - Audited `invite.create` (`kind: share_link`, `role: viewer`).
- **Revoke** (the host):
  - The link is revoked and its guests deleted in one transaction, so the next join is 404.
  - The relay notifier closes those guests (4403) in the same request. If it is down, the revoke
    stands and the failure is counted; the guests' membership is gone, so a relay that re-reads
    membership (2 s) drops them.
  - Audited `invite.revoke`.
- **Join** (public):
  - Rate limits: 10 per minute per address and 30 per minute per token (keyed by the token's
    hash). Over either: 429 with `Retry-After`. If the counters fail: 503 (fail closed).
  - The body is `{display_name}` (1-40 characters, no control characters). A `k` field (the E2E
    key) is 422. Any other field, a `role` included, is ignored.
  - These all get the same 404 body (`not_found`), after the same two lookups, so a token cannot
    be probed:
    - an unknown, expired, revoked or used-up link;
    - a session that is over;
    - a workspace without `relay_access`.
  - A locked session (B051 policy) is 403 `session_locked`. Past `max_session_members` (guests
    count) it is 403 `member_limit_reached`, and past B031's 50 slots 403 `session_full`.
    Entitlements that cannot be read are 503.
  - One transaction spends a use (`uses < max_uses`, so concurrent joins never pass the cap),
    writes the guest (a new `mem_` id with a B031 slot) and signs the ticket. A ticket that cannot
    be signed or recorded is 503 and spends nothing (the slot is given back).
  - The ticket is B017's `mintGuestRelayTicket`:
    - `{sid, mid, role: viewer, caps: []}`, with no `dev`;
    - `aud` `centcom-relay`, 60 s, a fresh `jti` recorded under `ticket:issued:`;
    - it cannot call the REST API (wrong audience).

    Audited `invite.accept` (actor: the API).
- **Sweep** (`ShareLinkService.sweep`, run by the worker's `session.expiry.sweep` every 60 s):
  deletes the guests of expired links and of sessions that are over, and closes them.

Tokens and tickets are never logged, stored in plain or put in a URL the server builds (other
than the link itself).

## Stores

Migration `20260102005000_share_links.sql`:

- `share_link`: `token_hash` unique, `uses <= max_uses`, `expires_at <= created_at + 24 h`.
- `guest_member`: the guests, with their slot.

Both cascade from their session, and guests from their link.

## Metrics

- `share_links_created_total`
- `share_link_joins_total{result}`: `joined`, `not_found`, `rate_limited`, `locked`,
  `member_limit`, `full`, `unavailable`.
- `share_link_ticket_failures_total{reason}`: `signing`, `record`.
- `share_link_close_failed_total`

## Limits

- **The relay does not admit guests yet.** It verifies a ticket's `dev` and reads membership from
  `session_members`, so it refuses a guest ticket today (fail closed). A relay lane must:
  - accept tickets without `dev` when the role is `viewer`;
  - read `guest_member` as live membership;
  - let guests send only `presence.update` and `reaction` (CT-RBAC);
  - consume the notifier's close requests;
  - honour `share_history = false` (no earlier epochs for guests).
- **Production adapters** for the notifier (a Redis publish to the relay) and the app wiring come
  with the API entrypoint, as for B054's routes.
- **Audit names:** CT-API-AUDIT's stable list has no share-link action, so links are audited as
  the `invite.*` actions with `kind: share_link`.

## Testing

`apps/api/test/share-links/` (B054's in-memory harness with B017's real token service;
`share-links.postgres` on Postgres 16 through DATABASE_URL):

- `share-links.create-revoke`: who may, bounds, the token, revocation and its relay close.
- `share-links.join`: the ticket's claims, the viewer-only property, `k` and names, REST refusal,
  signing failures.
- `share-links.concurrency`: 50 concurrent joins, exactly 10 uses.
- `share-links.probing`: one 404 body for every dead link, timing within 5 ms.
- `share-links.limits`: locked, member cap, entitlements down, rate limits, counters down.
- `share-links.privacy`: hashes only; no token or ticket in logs or audit.
- `share-links.postgres`: the store, atomic uses, rollback, revoke, sweep, the 24 h check.
