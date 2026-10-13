# Branch mode: several computers, each with its own agents (B110)

A session is created in one of two modes (`POST /v1/sessions {mode}`; fixed for its life, default `command_post`):

|                                                                                                                             | `command_post`                  | `branch`                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------- |
| Who runs agents                                                                                                             | the host only                   | every member, on their own computer           |
| Who emits `agent.*`, `message.*`, `tool.*`, `approval.request`, `diff.share`, `file.lock`, `agent.handoff`, `branch.update` | the host                        | the agent's owner (host may act on any agent) |
| Editors                                                                                                                     | send requests through the queue | emit events for their own agents              |
| Viewers                                                                                                                     | presence, reactions, comments   | the same                                      |

The relay reads `sessions.mode` (`agents/mode-store.ts`, cached for the session's life; a lookup that fails answers `service_unavailable`, an unknown session counts as a command post) and reports it in `welcome.p.session.mode`.

## What the relay enforces

- `agent.spawn`, `agent.state`, `agent.exit` (B057): in a command post only the host; in a branch session an editor only for agents it owns (`owner` is the sender); a spawn with someone else's id is `forbidden`.
- The command-post gate (`agents/mode-gate.ts`): in a command post an editor's `message.*`, `tool.*`, `approval.request`, `diff.share`, `file.lock` and `agent.handoff` are `forbidden`.
- `agent.handoff` offers in a branch session must come from the agent's owner (or the host).
- `file.lock` (B059): a non-host member may only lock for an agent they own (releases and renewals were already tied to the holding member).
- `approval.request` (B060): a non-host may only ask for an agent they own; `approver: "owner"` is decided by workspace owners and admins, never by the requester (unless they are one).
- `branch.update` and the relay's `conflict.detected` (B061): host only in a command post.
- Rate limits: 2 `agent.state` per second per agent (excess dropped silently), 20 board notes an hour per member (B111).

## What the relay cannot enforce (receivers must)

`message.*`, `tool.*`, `diff.share` and `branch.update` carry their `agent_id` inside the encrypted `ct`. The relay cannot tell whether the sender owns that agent. A receiving client must accept a frame about an agent only from the agent's owner (named in the `agent.spawn` the relay verified) or the host, and must show anything else as untrusted.

## Checking it

```
pnpm dev:up; pnpm dev:api; pnpm dev:relay
CENTCOM_CLIENT_DIR=../Centcom pnpm dev:branch-check   # a client built from the changed contracts for the board steps
```

Two new accounts share a branch session and each run their own agent: spawn, state, exit, messages, approvals decided by the workspace owner, file locks and the relay's `conflict.detected`, handoff offers, presence, board notes, the refusals above and the rate limits. `dev:replay-check` covers the durable log.

## Known gaps

- The client library's `createSession` has no `mode` option (`dev:branch-check` completes its request); clients need one.
- The client library does not map `frame_rate_exceeded` (the board limit) to a rejected send, and a frame the relay drops silently (`agent.state` over the limit, a denied lock) stays pending, so a later refusal can be matched to the wrong frame.
- Viewer refusals and history purge are covered by B043's and B055's own tests, not by `dev:branch-check` (the client library cannot send as a viewer).
