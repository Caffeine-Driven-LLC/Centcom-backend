# Fan-out (B044)

Delivers each sequenced frame to every connection of its session's room on this node, the
sender's included (its echo), strictly in `seq` order, as opaque bytes
([CT-WS-SESSION-EVENTS](../../../../contracts/04-session-events.md),
[CT-WS-ENVELOPE](../../../../contracts/03-ws-envelope.md) "Sequencing and delivery guarantees").
It is a relay module (`module.ts`, order 50) and sets `ctx.fanout` for the modules after it.

## Parts

| File         | What it does                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `fanout.ts`  | `createFanOut`: the stage, `deliver`, `emitServer`, gap handling, `ConnectionSender`, the `RemoteDispatcher` port (default: none). |
| `release.ts` | `OrderedRelease`: contiguous `seq` order per session, waiting frames bounded (2 000) and timed (250 ms), `onGap`.                  |
| `module.ts`  | Wiring: rooms from B043 (`roomsFor`), the stage at 50, `ctx.seq.delegateEcho()`, `ctx.fanout`.                                     |

## Rules

- **Which room:** the connection's authenticated session (`entry.sessionId`), never the frame's
  `sid` field.
- **Order:** every connection gets frames in contiguous `seq` order.
  - On one node, frames are offered in order: B041 resolves its store calls in order.
  - A frame after a missing one waits. After 250 ms, or with more than 2 000 waiting, the gap is
    fetched from the hot buffer (`SeqStore.range`).
  - If the hot buffer can't fill it, the room's connections close with **1001** after
    `sys.bye {reason: "resync"}`, so clients resume (B042), and the session's order starts afresh.
  - Nothing past a gap is delivered first.
- **The echo:** the module calls `ctx.seq.delegateEcho()`, so B041 no longer echoes new frames.
  Fan-out delivers them to the sender in order with everyone else's. B041 still echoes resends
  itself.
- **Opaque:** each frame is serialised once (`JSON.stringify` of B041's stored frame, whose `p`,
  `ct` and `sig` are the decoder's values), and that same text goes to every connection (through
  `RelayConnection.sendText`). The echo, the fan-out and the hot buffer carry the same bytes.
  `ct` is never parsed and re-stringified here.
- **Isolation:**
  - Closed connections are skipped.
  - A send that throws is counted, and the rest still get the frame.
  - Nothing awaits per recipient.
  - A session without a room on this node is still sequenced and buffered; its delivery is
    skipped and counted (`no_room`).
- **Server frames:** `emitServer(sid, kind, t, p)` builds a frame from `srv` (CT-WS-SESSION-EVENTS
  "Server identity"; the card said `server`, but the contract wins). It sequences it through
  B041's `submitServer` (same `seq` space, buffered, durably appended) and delivers it in order.
- **Other nodes:** `deliver` hands each locally sequenced frame to the `RemoteDispatcher` (B045's
  `ClusterDispatcher` publishes it; default none). Its failures are counted and never touch local
  delivery. B045 offers other nodes' frames to `release`.
- **Backpressure:** `ConnectionSender` (`send(text, {droppable})`, `bufferedBytes()`) is the seam
  B046 enforces slow-consumer policy on. This lane never drops a sequenced frame.
- **Where a session starts:** the first frame offered sets it, unless B042 primed it
  (`release.prime(sid, head + 1)`, done for each connection's handshake). That matters with
  frames from other nodes (B045), whose first arrival need not be the lowest. A pinned session
  (`pin`, B045 while subscribed) is never forgotten as idle. `setGapAfterMs` is B045's
  `RELAY_CLUSTER_GAP_MS`.
- **Holds (B042):** `hold(conn)` keeps what fan-out would send a replaying connection (and its
  resends' echoes, which B041 hands to `sendTo`) in a queue of at most `MAX_HELD_FRAMES` (10 000),
  in arrival order; the resume module takes them with `next()` after the replay and `end(sentUpTo)`
  in the same turn as the last one. After that, a late frame at or below `sentUpTo` is skipped
  (counted `replayed`), so nothing arrives twice. A hold that overflows closes the connection with
  **1001** (`sys.bye resync`) so its client resumes again.

## Config

None of its own: 2 000 frames and 250 ms are the card's constants.

## Metrics

- `relay_fanout_latency_seconds`: receipt (`ts`) to the last local write.
- `relay_fanout_deliveries_total{result}`: also `held`, `replayed` and `overflow` around a resume.
- `relay_fanout_gaps_total{result}`: `filled` or `resync`.
- `relay_fanout_remote_failures_total`

Logs carry the session, counts and seq ranges, never `p`, `ct`, `sig` or ids.

## Testing

`apps/relay/test/fanout/`:

- `fanout.release`: reordering, gaps, bounds.
- `fanout.order`: 5 members, 10 000 frames from 8 senders, a fast-check property, room isolation.
- `fanout.opaque`: byte-identical `ct`/`sig`/`p`/`id` over random payloads, server fields,
  unknown kinds.
- `fanout.server-frames`: `emitServer`.
- `fanout.isolation`: closed and throwing connections, no room, gap fill and resync, the remote
  port.
- `fanout.perf` and `fanout.bench.ts`: 50-member room, p95 and throughput.
- `fanout.relay`: SimClients on a running relay, resend echo, module wiring.
