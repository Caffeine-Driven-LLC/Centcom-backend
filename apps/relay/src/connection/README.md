# Connection state, heartbeat and closes (B040)

Keeps connections honest after the handshake
([CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) "Heartbeat" and "Close codes"): a
state machine per connection, server pings, dead-peer detection on one shared timer, and the one
way every connection is closed. It is a relay module (`module.ts`, order 12).

## States

| State            | Entered when                                             | Leaves for                             |
| ---------------- | -------------------------------------------------------- | -------------------------------------- |
| `awaiting_hello` | the upgrade is accepted                                  | `authenticating`, `draining`, `closed` |
| `authenticating` | its first message arrives (the hello, B038)              | `active`, `draining`, `closed`         |
| `active`         | the handshake has sent `sys.welcome`                     | `draining`, `closed`                   |
| `draining`       | the relay started closing it                             | `closed`                               |
| `closed`         | its socket closed (the peer left, or the close finished) | nothing                                |

Any other move throws `IllegalTransitionError` (`machine.ts`). Once `closed`, the connection is
forgotten: no timer, entry or listener is kept.

## Heartbeat

| What             | How                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Server pings     | `{v:1, t:"sys.ping", p:{t}}` (`t`: the server's monotonic ms), first at `ping_ms` ±10 % after the welcome, then every `ping_ms` |
| Client pongs     | Consumed; any `t` (a wrong one is ignored); they count as activity                                                              |
| Client pings     | Answered at once with `{v:1, t:"sys.pong", p:{t}}` echoing `p.t`; consumed                                                      |
| Activity         | Every inbound message, valid or not (a stage at order 5, before decoding), timed by the server's clock                          |
| Dead peer        | No inbound message for `dead_ms`: `sys.bye {reason:"dead_peer"}`, close 1000 (`dead_peer`), `relay_dead_peers_total`            |
| Event-loop stall | A tick over 5 s late holds dead checks one slot, so frames already received are read first                                      |

Pings and pongs are written straight to the socket: never sequenced, buffered or replayed. The
client's `t` is echoed, never trusted. Only `active` connections are pinged or checked; before
that, the handshake's 5 s hello timeout applies.

All deadlines of a node sit on one timer wheel (`wheel.ts`): 100 ms slots and a single platform
timer set for the earliest occupied slot (none when nothing waits). A dead check reads the time
since the last activity when it runs, so frames never reschedule it. 10 000 idle connections
cost about 0.2 % of one core (`test/connection/heartbeat.bench.ts`).

## Closing

`closeConnection(connection, spec)` (`close.ts`) is every close path (the handshake's refusals and
supersede, the codec's, a failing stage's 1011, shutdown's 1001 and the dead peer):

1. it checks `spec` against `CLOSE_FRAMES` and throws `CloseSpecError` for a missing or wrong
   frame;
2. it sends that frame: a `sys.error` (a CT-ERR problem, with `detail`, `errors`,
   `retry_after_s` and extra members as given) for 4400, 4401, 4403, 4404, 4408, 4426, 4429, 4503
   and 1011; a `sys.bye {reason}` for 4409 (superseded) and 1001 (going away); optionally a bye
   for 1000;
3. it closes with the code (the reason is the bye's reason or the error code);
4. it cuts the socket if it has not closed 1 s later.

A second call does nothing and returns false. The connection leaves the registry when its socket
closes (B037's close handler), so at most 1 s later. `ERROR_CLOSE` maps the CT-ERR codes that end
a connection to their close code (`closeCodeFor`).

## Configuration

| Key             | Default | Rule                                                 |
| --------------- | ------- | ---------------------------------------------------- |
| `RELAY_PING_MS` | `20000` | 1 000 to 300 000                                     |
| `RELAY_DEAD_MS` | `50000` | 2 000 to 900 000, and at least twice `RELAY_PING_MS` |

The handshake reads the same keys for `sys.welcome.heartbeat`, so what clients are told is what
the relay enforces. An invalid value stops the relay at startup (ConfigError).

## Tests

`test/connection/`:

- **`connection.state-machine.test.ts`:** all 25 moves, table-driven.
- **`connection.close.test.ts`:** the frame before every close code, refused specs, closing once,
  the 1 s cut, the error table, and on a running relay: one frame, one close, one registry removal.
- **`heartbeat.schedule.test.ts`:** first ping 18-22 s, then every 20 s; jitter bounds and spread;
  the welcome advertising the enforced values (a SimClient on a running relay).
- **`heartbeat.dead-peer.test.ts`:** silence closed at 50 s; answering (and slow) clients kept 10
  minutes; client pings, other frames and wrong pongs as activity; the stall grace; a SimClient
  that stops answering, and ping-to-pong time over a real socket.
- **`connection.leak.test.ts`:** 1 000 connect/disconnect cycles leave nothing (fake connections,
  and SimClients on a running relay).
- **`heartbeat.wheel.test.ts`:** the wheel.
- **`heartbeat.perf.test.ts`:** `heartbeat.bench.ts` in a child process: 10 000 connections, one
  timer, under 5 % of one core.
- **`connection.module.test.ts`:** wiring and configuration.
