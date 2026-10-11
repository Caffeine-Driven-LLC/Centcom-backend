# Agent registry (B057)

The relay's authoritative list of each session's agents, built from the cleartext `p` of the
`agent.spawn`, `agent.state` and `agent.exit` frames it lets through
([CT-WS-SESSION-EVENTS](../../../../contracts/04-session-events.md)), so late joiners and the
spawn limit never depend on a client replaying them. It is a relay module (`module.ts`, order 39,
beside B052's queue stage: after the control stage's mutes, before sequencing) and sets
`ctx.agents`.

## Public interface

| Export                                            | What it is                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `AgentRegistry.onSpawn/onState/onExit`            | `(sid, frame, sender, sequence)`: check, sequence (the rest of the pipeline), then record.  |
| `AgentRegistry.list(sid)`, `get`, `countLive`     | This node's view of the session's agents (`AgentRecord`), spawn order.                      |
| `AgentRegistry.snapshot(sid)`                     | The session's agents from the shared store, for roster and join flows (refreshes the view). |
| `AgentRegistry.setStateValidator(fn)`             | B058 injects the state map's check; until then any non-empty name of at most 64 characters. |
| `AgentRegistry.liveByMode()`                      | Live agents by mode on this node, for the `relay_agents_live{mode}` gauge.                  |
| `createRedisAgentStore`, `createMemoryAgentStore` | The store: Redis with a Postgres write-through, and memory (tests).                         |
| `createPostgresAgentEntitlements`                 | `max_parallel_agents` of the session's plan, cached 30 s.                                   |
| `createStateRateLimiter`                          | 2 `agent.state` per agent per second, counted in Redis.                                     |
| `agentStage`                                      | The pipeline stage.                                                                         |

`AgentRecord = {agentId, owner, mode: 'command_post' | 'branch', state, since, exited?: {outcome,
errorCode?}}`. `state` is `''` until the first `agent.state` (a spawn carries none).

## Rules

- **Who.** The mode is the session's (`SessionModePort`; CT-WS-ENVELOPE `welcome.p.session.mode`).
  No session stores one yet, and every session is created command-post
  (`apps/api/src/routes/sessions/list-create.ts:293`), so the relay's port answers `command_post`.
  In a command-post session only the host may spawn, update or end agents, whatever mode a frame
  declares. In a branch session an editor may spawn only with `owner` equal to their own member id
  (the server-stamped `from`), and update or end only agents they own; the host may act on any
  agent. Otherwise: `sys.error forbidden`. A spawn whose `p.mode` is not the session's is
  `invalid_frame`. B043 already refuses `agent.*` from viewers.
- **Spawn limit.** A spawn while the session runs `max_parallel_agents` agents (CT-ENTITLEMENTS:
  free 4, pro 8, team 16; null is unlimited) is refused `forbidden` with a detail naming the limit,
  and is not sequenced. An exit frees a place.
- **Idempotency.** A resend of a spawn frame by the member who sent it (same `msg_` id, owner and
  mode) is sequenced again (B041 echoes its first `seq`) and changes nothing. Any other spawn of a
  known agent id, someone else's copy of the frame included, is `invalid_frame` and not sequenced.
- **State.** Unknown agent: `invalid_frame`. Exited agent: ignored. A name the validator refuses:
  `invalid_frame`. The current state repeated, or a third frame within one second for one agent:
  dropped before sequencing (a sliding one-second window, B009's Redis rate limiter), counted (`relay_agent_state_dropped_total{reason}`), never answered
  or audited.
- **Exit.** Marks the agent exited with its outcome and error code; nothing brings it back.
- **Tolerance.** A `p` that fails the contract schema (unknown fields allowed) or the id checks is
  `invalid_frame`; the connection is never closed here. Only `p` is read, never `ct`.

## Storage

- **Redis:** one JSON document per session, `relay:agents:<sid>`, kept 48 h after its last
  change; every frame is handled under the lock `relay:agents:<sid>:lock` (30 s, released when the
  frame is done; waited for at most 2 s, then 503), so the nodes of a session agree.
- **Postgres:** table `agent` (migration `20260102004700_agents.sql`), upserted on every change
  before Redis is written: `session_id, agent_id, owner_member, mode, state, since, spawned_seq,
spawn_frame_id, spawned_by, exited_seq, outcome, error_code, rev, updated_at`. Never a label,
  branch, worktree or model. It cascades with its session.
- **Watermark:** each write takes the next `rev` from the `agent_rev_seq` sequence, and the Redis
  document records the newest `rev` it reflects. A document older than the table (writes made
  while Redis was down), missing or unreadable is rebuilt from Postgres.
- **Write failures:** a failed Postgres write keeps the change in Redis and is retried with the
  session's next save; a failed Redis write deletes the document so the next load rebuilds it.
- **Redis down:** agents are read from Postgres, changes go to Postgres only, and spawns are
  refused 503 (the limit fails closed); state and exit go on.

## Config

Constants from the card: 2 states per agent per second, a 30 s entitlement cache, the 48 h
document, the 30 s lock waited for 2 s. The Redis and Postgres connections are the relay's.

## Metrics

`relay_agent_state_dropped_total{reason}` (`rate`, `identical`, `exited`),
`relay_agent_spawns_refused_total{reason}`, `relay_agent_store_failures_total`, and the gauge
`relay_agents_live{mode}` (this node's live agents, read at each export).

## Failure modes

| Failure                                  | Behaviour                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Redis unavailable                        | Reads from Postgres; spawns refused `service_unavailable`; state and exit go on. |
| Store unreachable or the lock too busy   | `sys.error service_unavailable` (retry after 1 s); nothing sequenced.            |
| Entitlements cannot be read              | The spawn is refused `service_unavailable`.                                      |
| `agent.state` after `agent.exit`         | Ignored, `relay_agent_state_dropped_total{reason="exited"}`.                     |
| Plan downgraded                          | The cached limit holds for at most 30 s.                                         |
| Save fails after the frame was sequenced | Logged and counted; Postgres is retried with the next save, Redis rebuilt.       |

## Testing

`pnpm test` runs `apps/relay/test/agents/`: lifecycle, authorisation, limits, restart, privacy,
the contract fixtures and the stage over the in-memory store; `agents.postgres.test.ts` runs on
Postgres 16 and Redis (CI's integration job, or containers).
