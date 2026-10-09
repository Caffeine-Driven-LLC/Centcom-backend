# Session rooms and membership authorisation (B043)

Keeps this node's rooms (who is connected to which session) and decides who may be in a room and
who may send which frame, from the **live** membership record, never the ticket
([CT-RBAC](../../../../contracts/01-auth-rbac.md) rules 1-3 and the session matrix,
[CT-WS-SESSION-EVENTS](../../../../contracts/04-session-events.md) "Who may send",
[CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) close codes). A relay module
(`module.ts`, order 20).

## Parts

| File             | What it does                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind-policy.ts` | `KIND_MIN_ROLE` (roles per kind; empty = server-only), `authorizeFrame(m, frame, mute)`, the `MuteState` port with `noMutes` and `memoryMuteState`.     |
| `registry.ts`    | `RoomRegistry` / `Room`: rooms created on first join, connections per member, eviction 60 s after the last leave, `closeMember`, `listen` (B045).       |
| `membership.ts`  | The live record (`createPostgresMembership`) and `LiveMembership`, its cache: at most 2 s old, invalidated by membership events, failures never cached. |
| `access.ts`      | `createPostgresSessionAccess`: B038's `SessionAccess` port over Postgres, with the plan's `relay_access` / `max_session_members` and the room cap.      |
| `authorise.ts`   | `createRooms`: the handshake's `onAdmitted` join hook, the authorise stage (order 20) and the `centcom:membership` listener.                            |
| `runtime.ts`     | `roomsFor(ctx)`: one set of the above per relay, shared by the handshake module (which takes `access` and `onAdmitted`) and this module.                |

`RoomRegistry.listen` (B045) tells the cluster module of every join and leave, after the room
changed, so it subscribes to a session's and a member's channels while they have local
connections.

## Rules

- **Join** (in the handshake, before `sys.welcome`): the session, member and device come from the
  records (`SessionAccess`). The member's role is the session role capped by the workspace role (a
  `guest` is at most `viewer`, `billing` may not join). The session holds at most
  `max_session_members` distinct members (null means 50, and never more than 50); a member's other
  devices are not counted again. Over the cap: `session_full`, close **4403**, and no slot is
  assigned. The room cap is still per node; B045 routes frames across nodes, a shared count is a follow-up.
- **Frames** (order 20): `sys.*` and `ack` pass. `event`, `queue`, `control` and `presence` frames
  are checked against the live role (re-read at least every 2 s):

  | Outcome                   | What happens                                                                           |
  | ------------------------- | -------------------------------------------------------------------------------------- |
  | allowed                   | on to sequencing                                                                       |
  | forbidden                 | `sys.error forbidden` (`ref` = frame id), one `permission.denied` audit event, dropped |
  | muted (`event` / `queue`) | dropped silently                                                                       |
  | no longer a member        | the member's connections close **4403** `not_a_member`                                 |
  | records unreadable        | `sys.error service_unavailable` (`retry_after_s` 1), dropped, connection kept          |

  Server-only kinds are refused for everyone, the host included. Unknown kinds (from newer
  clients) pass for host and editor only. Where the catalogue and CT-RBAC differ the stricter rule
  holds: viewers may not send `presence.cursor`.

- **Membership events** (`centcom:membership`, B028): `removed` / `left` close the user's
  connections in that workspace's sessions with 4403 at once; `role_changed` re-reads their roles
  at once. Without the subscription the 2 s re-check still applies; subscribing is retried with
  backoff (1 s doubling, at most 60 s).

## Config

None of its own. The member cap comes from the plan, the 2 s cache from CT-RBAC, and the 60 s
eviction from the card. Mutes: nobody is muted until B051 provides a `MuteState`.

## Failure modes

- Membership read fails: privileged frames are refused with 503 (fail closed); the connection
  stays.
- Pub/sub lost: the 2 s re-check bounds how long a removed member keeps access; resubscribed with
  backoff (`relay_membership_subscribe_failures_total`).
- Eviction racing a join: `getOrCreate` is synchronous, so the joiner gets the live room or a fresh one.

Metrics: `relay_frames_authorised_total{outcome}`, `relay_room_joins_total{outcome}`,
`relay_membership_events_total{type}`, `relay_membership_subscribe_failures_total`. Logs carry
the kind, session, member and result only, never `p` or `ct`.

## Testing

`apps/relay/test/rooms/`:

- matrix and schema coverage: `rooms.authorize.matrix.test.ts`;
- live roles: `rooms.membership-live.test.ts`;
- caps: `rooms.limits.test.ts`;
- eviction and leaks: `rooms.lifecycle.test.ts`;
- audit: `rooms.audit.test.ts`;
- a real relay with WebSocket clients: `rooms.session-state.test.ts`;
- wiring and the handshake hooks: `rooms.module.test.ts`;
- Postgres (B010's test stack): `rooms.postgres.test.ts`.
