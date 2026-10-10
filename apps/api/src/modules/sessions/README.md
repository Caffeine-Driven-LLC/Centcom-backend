# Session lifecycle (B053)

Owns session rows and their state machine, so REST (B054), the relay and the worker agree on one
state ([CT-API-SESSIONS](../../../../../contracts/02-rest-api.md),
[CT-WS-CONTROL](../../../../../contracts/04-session-events.md) "Host failover"). It covers
creation and the concurrent-session limit, ending, host-loss pause, 24 h expiry, failover
eligibility, and a transactional outbox for the relay notification and the `session.*` domain
events. The routes are B054's.

## Parts

| File               | What it does                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `state-machine.ts` | `transition(from, event)`: the pure table; `SessionStateError` for anything else.                |
| `host-loss.ts`     | `evaluateHostLoss`: failover candidate after 120 s, pause at 10 min; the thresholds.             |
| `lifecycle.ts`     | `SessionService`: create, get, list, rename, policy defaults, end, host presence, sweep, outbox. |
| `repository.ts`    | The SQL: conditional transitions, the locked sweep, keyset listing, the outbox.                  |
| `ports.ts`         | Entitlements (B080), the relay notifier, domain events (B081); the `Session` shape.              |

## States

| From                   | Event           | To      | When                                 |
| ---------------------- | --------------- | ------- | ------------------------------------ |
| (none)                 | create          | live    | `POST /v1/sessions`                  |
| live (pending)         | `host_lost`     | paused  | the host gone 10 min (the sweep)     |
| paused (pending)       | `host_returned` | live    | the host connects again              |
| live, paused (pending) | `end`           | ended   | the host, or a workspace owner/admin |
| paused                 | `expire`        | expired | paused 24 h (the sweep)              |

`pending` (B008's default) is kept for older rows and behaves like `live`. Ended and expired are
final. Every transition is a conditional `UPDATE … WHERE state IN (sources)`, so two instances
never both win one; a lost race changes nothing. Rows are never deleted here.

## Rules

- **create:**
  - The name: 1-80 characters, NFC, no control characters (CT-IDS Text). The region:
    `[a-z][a-z0-9-]{1,31}`.
  - Then B080's checks, given 2 s: `relay_access` must be on, and the workspace's sessions not
    over (live, paused) must be under `max_concurrent_sessions`. A refusal is 403
    `entitlement_required`; a timeout or failure is 503 (`retry_after_s` 5), and no row.
  - The session starts `live` with `last_host_seen_at` = now, so a host who never connects is
    paused after the grace too. It gets its host member (slot 0, with its slot row), the policy
    defaults (B051's `session_policy`) and a `session.created` outbox row.
- **end:** the host, or a workspace owner or admin; anyone else gets 403 `host_required`. An ended
  or expired session is returned unchanged. `end_reason` is `done`, `abandoned` or `error`.
- **rename / setPolicyDefaults:** the host only, while the session is not over.
- **Host presence** (the relay calls these):
  - `onHostConnected`: records the host as connected; a paused session goes back to live with
    exactly one `live` notification and a `session.started` event;
  - `onHostDisconnected(at)`: records when the host was last seen.
- **Failover:** `hostLoss(id, editors)` returns the longest-connected editor once the host has
  been gone 120 s and the policy's `auto_failover` is on. Otherwise null, and the session pauses
  at the grace. Promoting the editor is the relay's (it knows who is connected).
- **sweep(now)** (the worker's `session.expiry.sweep`, every 60 s):
  - pauses live sessions whose host has been gone 10 min, and expires sessions paused 24 h;
  - takes at most 500 of each per run, under `pg_try_advisory_xact_lock`, so a second sweeper at
    the same time does nothing, and each row is a conditional UPDATE;
  - is idempotent: a crashed run leaves the rest for the next, and no row is moved twice.
- **Notifications:** each transition writes a `session_outbox` row in its own transaction. After
  the commit (never before) it is delivered:
  - `control.session_state` to the relay (`RelayNotifierPort`), with the session's current
    state, so a late retry never sends an old one;
  - the domain event (`session.created`, `.started`, `.ended`; CT-WEBHOOKS data
    `{session, host, name, state}`) with a fixed id per row, so a redelivery is the same event.

  A failure keeps the row, retried 5 s later, doubling, at most every 10 min, by the next sweep
  or transition. The relay also reconciles on connect (the handshake reads the state).

## Stores

Migration `20260102004100_sessions_lifecycle.sql`:

- `sessions` gains `host_member_id`, `host_connected`, `last_host_seen_at`, `paused_at`,
  `expires_at`, `end_reason` and `updated_at`, with indexes for the sweep and the workspace list.
- `session_outbox` holds the transitions to deliver, and cascades from its session.

## Metrics

- `session_transitions_total{state}`: `live`, `paused`, `ended`, `expired`.
- `session_outbox_failed_total{target}`: `relay`, `event`.
- `session_expiry_failed_total`: dead-lettered sweep runs (worker).

## Limits

- **Relay wiring:** the relay calls `onHostConnected` / `onHostDisconnected` and consumes the
  notifier's messages. That wiring comes with B054 (and a relay subscriber), because
  `apps/relay` does not import `apps/api`. Until then the relay keeps reading the state at
  handshake (ended and expired are 4404).
- **"Live hosted sessions"** for `max_concurrent_sessions` counts live and paused sessions (a
  paused one can resume at any time).

## Testing

`apps/api/test/sessions/lifecycle/` (Postgres 16 through DATABASE_URL):

- `lifecycle.state-machine`: the table, a property over every pair, illegal transitions leave
  the row untouched.
- `lifecycle.host-loss`: 599 s and 600 s, a host who never connects, the host back, failover.
- `lifecycle.limits`: create, `relay_access`, `max_concurrent_sessions`, entitlements failing or
  hanging, names, end permissions.
- `lifecycle.sweep`: 24 h ± 1 s, idempotence, concurrent sweepers, outbox retry, the worker job.
- `lifecycle.repository`: 3 pages of 50 stable with inserts between pages, filters.

`apps/worker/test/session-expiry.test.ts`: the job, its schedule and retries.
