# Advisory file locks (B059)

The relay arbitrates `file.lock` frames
([CT-WS-SESSION-EVENTS](../../../../contracts/04-session-events.md)) on `path_hmac` only: the
BLAKE2b-MAC of a path under the session's path key, computed by clients. The path itself stays in
`ct` and never reaches the relay. Locks are advisory: nothing is enforced on a file system, and no
non-lock frame is ever refused because of a lock. It is a relay module (`module.ts`, order 39,
beside B052's queue and B057's agents stages: after B051's mutes, before sequencing).

## Public interface

| Export                                          | What it is                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LockService.handle(ctx, frame)`                | `granted`, `denied{holder, reason}`, `queued{position}`, `released`, `ignored` or `refused`.             |
| `releaseAllForAgent(sid, agentId)`              | Frees an agent's locks (its `agent.exit`), with `expire` frames; grants waiters.                         |
| `releaseAllForMember(sid, memberId)`            | The same for a member who left or was kicked; drops their waiters.                                       |
| `sweep(now)`, `watch(sid)`                      | Frees locks expired at `now` in the sessions this node watches (each room it has); resolves to how many. |
| `releaseAll(sid)`                               | Frees every lock of a session (`control.end`).                                                           |
| `heldCount()`                                   | Locks held in those sessions (the `relay_locks_held` gauge).                                             |
| `createRedisLockStore`, `lockStage`, `clampTtl` | The Redis store, the pipeline stage, the TTL clamp.                                                      |
| `ConflictHintPort`                              | B061 is told who holds a path whenever an acquire is refused.                                            |

## Rules

- **Acquire** (clients): a free path is granted and the client's frame is sequenced, so everyone
  sees the holder. The holder's own re-acquire (by its member or the host) extends the TTL. A path
  held by another agent: the requester joins the path's FIFO queue (at most 10) and a server
  `file.lock {action: deny, path_hmac, agent_id: <holder>}` is sequenced; the acquire itself is not.
  The 11th waiter is denied without queueing. The 501st lock of a session and the 101st of an agent
  are denied (`agent_id` is then the requester's own).
- **Release** (clients): by the holder's member or the host, it frees the path; the first waiter
  is granted in the same sequencing batch (a server `acquire` right after the release). By anyone
  else: ignored, not sequenced.
- **TTL:** CT-WS-SESSION-EVENTS "Limits": default 300 000 ms, clamped to 5 000 to 3 600 000.
  `sweep` frees expired locks (a server `expire` each) and grants their first waiters; an acquire
  that finds an expired lock does the same first. The module sweeps every second.
- **Cleanup:** an agent's locks go once its `agent.exit` is sequenced; a member's once their
  `control.kick` is (B051 then sends `control.member_left`); the session's once `control.end` is.
  A member's locks also go when it has left: connected on no relay node 10 s after its last
  connection closed (CT-WS-SESSION-EVENTS' reconnect grace). Which nodes a member is connected on
  is kept with the session's locks, so a member still connected elsewhere, or back within the
  grace, keeps them; a crashed node's stale entry leaves the lock TTL as the bound. A node writes a
  member's joins and leaves one at a time, in the order it saw them, and records only its first
  connection (retrying a failed write while the member stays connected, up to 5 times); a leave
  from a node the member was not recorded on frees nothing. A join that still fails while the
  member's earlier departure is in its grace lets that grace free its locks. Each departure from every node is marked in the record, and only the
  latest one's grace may free the locks (a rejoin anywhere clears the mark). A member leaving while its node shuts down keeps its locks until their TTL.
- **Order:** a change is saved before anything about it is sequenced, so a failed save is a 503
  with nothing broadcast. When sequencing refuses a client's frame (B041's rate limit or store),
  the state before it is saved back and the outcome is not remembered.
- **Waiters at the agent cap** when their turn comes are denied and skipped.
- **Server actions:** `deny` and `expire` are the relay's; from a client they are `invalid_frame`.
- **Resends** (same session, sender and frame id) replay their outcome; a waiter is never queued
  twice.

## Storage

- `locks:<sid>`: one JSON document per session with the held locks (`hmac`, agent, member, expiry,
  TTL) and the wait queues, kept a day after its last change.
- `lock:<sid>:<path_hmac>`: `{agent, member, expires_at}` with the lock's TTL (`PX`), so Redis
  expires a lock on its own if no sweep runs; deleted on release.
- Every change runs under `locks:<sid>:mutex` (`SET NX PX`, 30 s, released when the change is
  done; waited for at most 2 s): no two
  holders of a path can exist. Redis down: `sys.error service_unavailable`, never an
  unsynchronised grant.

## Metrics

`relay_locks_held` (gauge), `relay_lock_denials_total{reason}` (`held`, `queue_full`,
`session_cap`, `agent_cap`), `relay_lock_wait_ms` (histogram: queued to granted),
`relay_lock_expired_total`, `relay_lock_emit_failures_total`.

## Failure modes

| Failure                              | Behaviour                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Redis down                           | Acquire and release refused `service_unavailable`; nothing granted.                                          |
| Sweep missed (a pause)               | The lock keys expire in Redis on their own; the next sweep emits `expire` for what the document still holds. |
| Duplicate frame (same sid, from, id) | The same outcome, no second waiter.                                                                          |
| A save fails                         | `service_unavailable`; nothing sequenced or granted.                                                         |
| A server frame cannot be sequenced   | Logged and counted (`relay_lock_emit_failures_total`); the state stays saved.                                |

## Testing

`pnpm test` runs `apps/relay/test/locks/`: arbitration (100 interleaved races and a property test
over random interleavings), TTL and clamping, cleanup, caps, privacy (every Redis key and value
scanned against an allow-list), the contract fixture and member leaves through the module (fake
timers), over B009's in-memory Redis.
