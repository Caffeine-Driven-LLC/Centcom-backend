# Presence history (B067)

Server-side presence history: when members came online and went offline in a session, and when they
were last seen, for other backend lanes (admin, search, members listing). Connection facts only:
CT-WS-PRESENCE keeps presence ephemeral, so no status, activity or cursor is stored. No route.

## Interface

| Member                                        | What it does                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PresenceHistoryRecorder.onConnected(e)`      | A member came online (`{sid, memberId, deviceId, at}`): buffered for `presence_log` and last-seen.   |
| `PresenceHistoryRecorder.onDisconnected(e)`   | A member went offline (`reason`: closed, timeout or kicked), at the time its last connection closed. |
| `PresenceHistoryRecorder.touch(e)`            | Activity: last-seen, at most once per minute per connection.                                         |
| `createConnectionEvents`                      | Turns this node's room joins and leaves into online/offline, with B047's 10 s grace.                 |
| `ctx.presenceHistory.lastSeen(sid, memberId)` | The start of the current minute while connected; else the last disconnect; null if never connected.  |
| `ctx.presenceHistory.recentSessions(dev, n)`  | The device's sessions, newest first (n <= 50), only those its member still belongs to.               |
| `ctx.presenceHistory.purgeOlderThan(cutoff)`  | Deletes `presence_log` rows older than `cutoff` (30 days; B090 schedules it); how many.              |

## Rules

- **Online/offline:** a member's first connection on this node makes it online; when its last one
  closes, it goes offline only if none comes back within RELAY_OFFLINE_GRACE_MS (10 s, B047's
  setting), so a reconnect in the grace writes nothing. The reason comes from the close code
  (4403 kicked, 1006 timeout, else closed).
- **Last seen:** every frame from a connection touches it, and every member connected here is
  touched once a minute; a connection is written at most once a minute. A row moves forward only:
  an event older than the row changes nothing. A connected row older than three minutes no longer
  counts as online (a crashed node's members).
- **Off the hot path:** every call only buffers; online/offline events are written every second
  or at 200 (after the call returns), and at shutdown. Touches wait apart, the latest per member
  (bounded by the members connected here), so a minute's sweep never pushes events out. Database
  down: events wait (at most 10 000; the oldest are then dropped and counted) and only the timer
  tries again; the relay is unaffected. Events of a session deleted meanwhile are skipped by the
  writer (the live sessions are held `FOR KEY SHARE` for the batch), so they never refuse the
  others'; a batch Postgres still refuses is dropped and counted, so it cannot block later writes.
- **Shutdown:** members still in their grace are written offline at once, at their close time,
  then everything is flushed.
- **Per node, as B047:** a member whose connection on one node goes offline reads offline until
  its other node's next touch (at most a minute).
- **Out of order:** an offline event for a member not online is ignored (debug log).
- **Retention:** `presence_log` 30 days; `member_last_seen` lives with the session (a kicked
  member's row stays for audit; `recentSessions` leaves its session out).

## Storage (Postgres, migration `20260102004900_presence_history.sql`)

- `presence_log(id, session_id, member_id, device_id, event, reason, at)`.
- `member_last_seen(session_id, member_id, device_id, last_seen_at, connected)`, primary key
  `(session_id, member_id)`.

Both cascade from their session.

## Metrics

`relay_presence_history_events_total{event}` (connect and disconnect rates),
`relay_presence_history_flush_failures_total`, `relay_presence_history_dropped_total`.

## Testing

`pnpm test` runs `apps/relay/test/presence-history/`: the recorder (the grace in a replayed
scenario, reasons, the one-a-minute throttle, buffering and the outage), the lookups, the purge and
the schema allow-list and the module wiring (a kick through the rooms) on Postgres 16 (B010's
stack).
