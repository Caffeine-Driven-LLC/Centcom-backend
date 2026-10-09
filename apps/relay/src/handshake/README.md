# Relay handshake (B038)

Turns an upgraded WebSocket into a session member, or closes it
([CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) "Handshake",
[CT-AUTH](../../../../contracts/01-auth-rbac.md) "Relay ticket", CT-VER). It is a relay module
(`module.ts`, order 15): a pipeline stage plus a connection handler.

## Steps and close codes

| Step                                                                 | Refusal                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sys.hello` within 5 s of the upgrade                                | `sys.error` `protocol_violation`, close **4408**                     |
| The first frame is `sys.hello`, JSON text                            | `protocol_violation` / `invalid_frame`, **4400**                     |
| `p.ticket` present                                                   | `ticket_invalid`, **4401**                                           |
| The hello matches `envelope.schema.json`                             | `invalid_frame`, **4400**                                            |
| A shared protocol, and `client.version` ≥ `RELAY_MIN_CLIENT_VERSION` | `client_too_old` with `p.upgrade {protocols, min_version}`, **4426** |
| Ticket verifies (`ticket.ts`)                                        | `ticket_invalid` (one uniform body), **4401**                        |
| Ticket unused: `jti` stored with `SET NX`, 120 s                     | `ticket_replayed`, **4401**                                          |
| Session known (`SessionAccess`)                                      | `session_not_found`, **4404**                                        |
| Session not ended or expired                                         | `session_ended`, **4404**                                            |
| Member still a member                                                | `not_a_member`, **4403**                                             |
| Device not revoked                                                   | `forbidden`, **4403**                                                |
| Workspace has `relay_access`                                         | `entitlement_required`, **4403**                                     |
| Room has space (B043, `SessionAccess` or `onAdmitted`)               | `session_full`, **4403**                                             |
| Keys, Redis or `SessionAccess` (2 s) answer                          | `service_unavailable` with `retry_after_s`, **4503**                 |

On success the client gets `sys.welcome` with:

- the negotiated `protocol` and `caps` (only capabilities both sides advertise);
- `member` (id, name, slot, and the **live** role, never the ticket's);
- `roster_v`, `heartbeat {ping_ms, dead_ms}` (the values B040's connection module enforces:
  `RELAY_PING_MS` and `RELAY_DEAD_MS`, 20 000 and 50 000 by default) and `server_time`;
- `limits` (CT-WS-ENVELOPE defaults, `max_members` capped at 50), `session.state` and `resume: null`.

The connection becomes `authenticated` with its `sessionId`, and later frames pass to the next
stages. Nothing else is sent before the welcome; frames that arrive while the hello is being
checked are dropped. A connection of the same `(member, device)` already on this node gets
`sys.bye {reason: "superseded"}` and close **4409**. Every refusal and the supersede close
through B040's `closeConnection`, which sends the frame first and closes once.

## Tickets and keys

- Tickets are EdDSA only, with `typ` JWT, issuer `https://api.centcom.dev`, audience
  `centcom-relay`, and 60 s of skew on `exp` and `iat`. `sid`, `mid`, `dev`, `role`, `caps` and
  `jti` must be well formed. `alg: none`, HS256 and a ticket's own `jwk`/`jku` are refused.
- Keys come from `RELAY_JWKS_URL` (`jwks.ts`). They are kept 10 minutes. An unknown `kid`
  refetches at most once per 30 s, and concurrent lookups share one fetch. When the API cannot be
  reached, the last keys keep working for an hour after their fetch, then handshakes close 4503.

## SessionAccess

`access.ts` defines the port: `resolve(sid, mid, dev)` gives the session state and member limit,
the member (or null when the membership is gone), whether the device is revoked, `relay_access`,
and optionally `rosterV`. `module.ts` uses B043's Postgres implementation (`rooms/access.ts`,
through `roomsFor`). A 403 from the access itself (`session_full`) closes **4403** with that code.
After the live checks, `onAdmitted` (B043's room join) runs before the welcome: a refusal closes
4403, a throw 4503. `unavailableSessionAccess` (every lookup a 503, so hellos close 4503) stays
for relays without the rooms.

## Configuration

| Key                        | Default                                         | Rule                              |
| -------------------------- | ----------------------------------------------- | --------------------------------- |
| `RELAY_JWKS_URL`           | `https://api.centcom.dev/.well-known/jwks.json` | http(s), no query or credentials  |
| `RELAY_MIN_CLIENT_VERSION` | `0.0.0`                                         | semver                            |
| `RELAY_CAPS`               | `resume,cursor.coalesce`                        | comma-separated, at most 16 names |

## Observability

- `relay_handshakes_total{outcome}`: `welcome` or the refusal reason (`timeout`, `not_hello`,
  `invalid_frame`, `ticket`, `replay`, `too_old`, `session_unknown`, `session_ended`,
  `membership`, `device`, `entitlement`, `unavailable`).
- `relay_superseded_total` and `relay_handshake_frames_dropped_total`.
- `relay.handshake_refused` (info) logs the close code and the reason only, never the ticket or
  `hello.p`.

## Tests

`apps/relay/test/handshake/`: `ticket`, `negotiation`, `access`, `timeout`, `supersede`, `jwks`,
`module`. `ticket-bench.ts` is run by the ticket test in a child process for the 5 ms p95 check.
