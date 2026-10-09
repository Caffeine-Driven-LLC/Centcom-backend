# Cursors and typing (B048)

Throttles the high-rate ephemeral signals of
[CT-WS-PRESENCE](../../../../contracts/04-session-events.md):

- **Cursors** (`presence.cursor`): the relay keeps only the latest per member. At most 10 a second
  come in, and one per member per 100 ms goes out.
- **Typing:** a `presence.update` with `activity: "typing"` that is not refreshed for 5 s is
  cleared by the relay.

Neither is ever sequenced, buffered, replayed or stored. It is a relay module (`module.ts`, order
36 = `STAGE_ORDER.cursors`, after B047's presence).

## Parts

| File          | What it does                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `throttle.ts` | `createCursorThrottle`: a latest-wins slot per member, the rate, the size cap, the 100 ms tick, floods. |
| `stage.ts`    | The stage (36): offers a welcomed connection's cursor under its member, `invalid_frame` when too large. |
| `typing.ts`   | `createTypingTracker`: a 5 s timer per typing member, cleared through B047's service.                   |
| `config.ts`   | `RELAY_CURSOR_IN_PER_S`, `RELAY_CURSOR_TICK_MS`, `RELAY_TYPING_TTL_MS`, `RELAY_CURSOR_MAX_CT_BYTES`.    |
| `module.ts`   | Wiring: the stage, the throttle (published to other nodes), typing over `ctx.presence`, leaves.         |

## Rules

- **Cursors in.**
  - A member may send `RELAY_CURSOR_IN_PER_S` (10) in any one second. The relay keeps the times
    of the last 10 accepted, so memory is constant; more are dropped silently.
  - A `ct` larger than `RELAY_CURSOR_MAX_CT_BYTES` (4 KiB, serialised) gets `sys.error
invalid_frame` (pointer `/ct`), and the connection stays.
  - An accepted cursor replaces the member's slot. There is no queue.
  - A client's `from` is never read: the connection's member is stamped.
- **Cursors out.**
  - Every `RELAY_CURSOR_TICK_MS` (100 ms), each slot that changed goes out once as
    `{v, t: "presence", sid, from, ts, k: "presence.cursor", ct, sig?}`. Unchanged slots send
    nothing.
  - It goes to every welcomed connection of the session here, as droppable: B046 drops it for a
    connection over its soft mark, and counts it. It is also published to the other nodes on
    B045's ephemeral channel.
  - `ct` is measured for the cap and carried as it came; it is never read, logged or stored.
- **Floods.** A member sending more than 10× the limit in every second for 10 seconds is closed
  4429 (`rate_limited`).
- **Typing.**
  - Each of a member's `presence.update`s (B047's `onUpdate`) with `activity: "typing"` restarts a
    `RELAY_TYPING_TTL_MS` (5 s) timer. Any other activity, or the member leaving the session here,
    cancels it.
  - When the timer runs out, the relay sends one `presence.update` for the member through B047's
    service: `activity: "idle"`, same `status` and `agent_count`. B047's limits apply, so it can
    come late, never early. Nothing a client sends can trigger it.
- **Leaving.** A member's last connection leaving the session's room here drops its cursor slot
  and typing timer. A slot idle for a minute goes too.

## Config

| Key                         | Default | Rule              |
| --------------------------- | ------- | ----------------- |
| `RELAY_CURSOR_IN_PER_S`     | `10`    | 1 to 1 000        |
| `RELAY_CURSOR_TICK_MS`      | `100`   | 10 to 10 000 ms   |
| `RELAY_TYPING_TTL_MS`       | `5000`  | 100 to 600 000 ms |
| `RELAY_CURSOR_MAX_CT_BYTES` | `4096`  | 64 to 65 536      |

## Metrics

- `relay_cursors_total{result}`: `accepted`, `dropped_rate`, `dropped_size`.
- `relay_cursors_forwarded_total{result}`: `queued`, `dropped`, `closed`, `error`.
- `relay_cursor_flood_closed_total`, `relay_typing_cleared_total`

## Testing

`apps/relay/test/cursors/`:

- `cursors.throttle`: 50 in a second; a fast-check property; floods.
- `cursors.tick`: the 100 ms tick, changed-only, stamping, other nodes, backpressure.
- `cursors.size`: the 4 KiB boundary.
- `typing.autoclear`: 5 s, refresh, other activity, leave.
- `cursors.memory`: 1 000 000 offers.
- `cursors.not-sequenced`: `head`, buffer and log untouched.
- `cursors.module`: wiring and settings.
