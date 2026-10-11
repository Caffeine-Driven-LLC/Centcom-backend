# Approval routing (B060)

Routes `approval.request` and `approval.decision` (CT-WS-SESSION-EVENTS) between the right
approvers, enforces delegation and expiry, and tells the notification dispatcher, using only the
cleartext `p` (ids, risk, approver, expiry, decision, scope). The summary, command, cwd and reason
stay in `ct`; the relay never reads them.

## Interface

| Member                               | What it does                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `ApprovalRouter.onRequest(ctx, f)`   | Checks and stores a request, has it sequenced (`ctx.sequence()`), and notifies once per approval id.                   |
| `ApprovalRouter.onDecision(ctx, f)`  | Authorises the decider, claims the approval (first decision wins) and has the decision sequenced.                      |
| `ApprovalRouter.sweep(now, keep?)`   | Sequences the server's timeout deny for every expired approval in the watched sessions, once; resolves to how many.    |
| `cancelForAgent` / `cancelForMember` | Drops pending approvals of an exited agent, or those a kicked or muted member requested (no deny).                     |
| `watch(sid)` / `pendingCount()`      | Sessions the sweep covers; the `relay_approvals_pending` gauge.                                                        |
| `NotifyPort.approvalNeeded(sid, a)`  | `{approvalId, agentId, risk, approver, requester}`: becomes CT-NOTIF-PAYLOAD `approval_needed {agent, session, risk}`. |

`PendingApproval = {approvalId, agentId, requester, risk, approver, expiresAt, requestedAt, requestSeq, frameId}`.

## Rules

- **Request:** from the host, or the member who owns the agent (B057's registry); anyone else gets
  `forbidden`. `expires_at` in the past, or more than 24 h ahead, is `invalid_frame`
  (CT-WS-SESSION-EVENTS "Limits"; the schema requires `expires_at`, so the contract's 10-minute
  default never applies). A second request with the same `approval_id` is `invalid_frame`; a resend
  of the same frame is passed on for the sequencer to ack again and notifies nobody.
- **Deciders** (CT-WS-SESSION-EVENTS "Who may send `approval.decision`", within CT-RBAC): read from
  live membership on every decision, never from the frame or the ticket. Viewers never decide. The
  host always may. Members in `control.policy.approvers` may. Otherwise the request's `approver`
  says who: `host`, nobody else; `any_editor`, any editor; `owner`, workspace owner or admin
  members in the session. A requester cannot decide their own request unless they are the host. A
  refused decider gets `forbidden` and one `permission.denied` audit event.
- **First decision wins:** the decision claims the approval with `SET NX` before it is sequenced;
  a later decision is `forbidden`. A decision whose sequencing is refused gives the claim back; one
  whose sequencing failed in an unknown way keeps it (a second decision must never follow one that
  may have gone out).
- **Resends:** B041 reports a resent frame as a duplicate with its original place
  (`SEQUENCED_DUPLICATE_KEY`), and a store failure during the assign as an unknown outcome
  (`SEQUENCE_UNKNOWN_KEY`). Only a refusal before the store was asked, on a frame's first attempt,
  releases its decision claim or removes its request (never one a resend already settled); an
  unknown outcome keeps them. A resend never releases or removes anything (its own refusal says
  nothing about the original). While a copy of the frame is on its way to the sequencer on this
  node, a resend is left to that copy's echo; otherwise it asks the sequencer, which acks it again
  or stores it, so a frame whose outcome got lost counts once a resend gets through. A resent
  request must repeat the original's `p`. A resend of a never-recorded decision past the
  approval's expiry (kept on the claim) is refused `gone`. A decided approval id cannot be
  requested again; the request's own frame sent again (also after the timeout deny) is acked.
- **Expiry:** at `expires_at` the sweep claims the approval as the server and sequences
  `approval.decision {decision:'deny', scope:'once'}` from `srv`, once even with several sweepers.
  A decision at or after `expires_at` is refused `gone`. A deny that cannot be sequenced gives the
  claim back for the next sweep (if the failure left it unclear whether the deny went out, it can
  go out twice: server frames carry no de-duplication key). An expired entry whose decision is held
  is tidied away, never denied, a minute after its expiry; claims are kept as long as the session
  list, so no entry outlives its claim.
- **Scopes** are forwarded as they are; the relay remembers none and answers nothing on its own.
  The timeout deny is the only server decision.
- **Cleanup:** once an `agent.exit` is sequenced, that agent's pending approvals are dropped; once
  a `control.kick` or `control.mute` is, those the member requested. No deny is sent for them.

## Storage (Redis)

- `approval:<sid>:<apr>`: the pending approval (JSON), `SET NX`, TTL `expires_at` + 60 s.
- `approval:<sid>:<apr>:decided`: the decision claim `{by, frame, seq?}`, `SET NX`, kept a day
  (as long as the session list).
- `approvals:<sid>`: the session's pending approvals (for the sweep and cleanup, and a restart),
  changed under `approvals:<sid>:mutex` (`SET NX PX` 30 s), kept a day after its last change.

Keys and values hold ids, the risk and approver enums, times and seqs only.

## Wiring (`module.ts`, order 39)

The stage sits beside the queue, agents and locks stages, after B043's authorisation and B051's
mutes. The sweep runs every second over every session a member joined on this node; a restarted
node picks a session's approvals up from Redis, with their original `expires_at`, when a member
joins. Deciders come from Postgres (`postgres.ts`) and B051's policy; agent owners from B057's
registry; the deny goes out through B044's `emitServer`.

**Notifications:** `notify.ts` (`dispatcherNotify`) publishes one `approval_needed`
`{agent, session, risk}` event per approval to B063's dispatcher (`publish`), for the session
members who may decide it (`mayDecide` over `postgres.ts`'s `members`), deduped by the approval id,
in the background; a failure is counted. The module still wires a no-op port: the relay has no
publisher for B063's `notify.dispatch` queue yet (no BullMQ client; B076's quota signals take the
same `publish` port, unwired too). Passing a publisher in is the follow-up.

## Metrics

`relay_approvals_pending` (gauge), `relay_approval_timeouts_total`,
`relay_approval_decision_latency_ms` (histogram), `relay_approval_notify_failures_total`,
`relay_approval_emit_failures_total`.

## Testing

`pnpm test` runs `apps/relay/test/approvals/`: routing (the approver matrix, requesters, viewers,
self-approval, scopes), expiry (bounds, one deny with two sweepers, late decisions, retries,
failed tidy-ups, restart), races (100 approve/deny races, racing resends), cleanup (exit, kick,
mute, and the stage), notify (exactly once, with a sequencer that drops duplicates as B041 does),
the dispatcher event, privacy (every Redis key and value scanned), the contract fixtures and the
module, over B009's in-memory Redis with a fake clock. `approvals.postgres.test.ts` runs the decider query
on Postgres 16 in CI's integration job.
