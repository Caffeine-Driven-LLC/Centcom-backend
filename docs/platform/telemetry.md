# Telemetry

Lane B085 ([CT-TELEMETRY](../../contracts/08-integrations.md),
[telemetry.schema.json](../../contracts/schemas/telemetry.schema.json)). Telemetry is off by
default: clients send it only when the user opts in, and honour `DO_NOT_TRACK=1` and
`CENTCOM_TELEMETRY=off` themselves. The server cannot know whether a client should have sent a
batch, so it never looks that up: it accepts what arrives, keeps only what the allow-list names,
and never ties it to a person.

## The endpoint

`POST /v1/telemetry/events`, anonymous or not, body `{install_id, app?, events: [...]}`. The answer
is always `204` with an empty body, for a valid batch, invalid JSON, a body over 64 KiB, more than
100 events, unknown types, a wrong content type, no credential or a bad one, a rate limit, or an
internal failure. Nothing about why goes back, and there is never a `Retry-After`.

The route reads no credential: a batch sent with a bearer token is stored exactly as the same batch
sent without one.

## What is kept

| Type                    | Props kept                                                 |
| ----------------------- | ---------------------------------------------------------- |
| `app.start`, `app.exit` | none                                                       |
| `command.run`           | `name`: one to four lower-case words (`session join`)      |
| `session.created`       | `mode` (a lower-case word), `transport` (`relay` or `lan`) |
| `session.joined`        | `transport`                                                |
| `agent.state_change`    | `from`, `to`: keys of `contracts/state-map.json`           |
| `feature.used`          | `key`: dotted lower-case words (`editor.split`)            |
| `error.shown`           | `code`: a CT-ERR code                                      |
| `perf.startup`          | `ms`: 0 to 600 000                                         |
| `perf.frame`            | `p95_ms`: 0 to 60 000                                      |
| `update.result`         | `from`, `to` (SemVer), `ok` (boolean)                      |

- `install_id` must be a ULID (the client's random, resettable per-install id).
- An event's `at` must be RFC 3339, at most 90 days old and at most 10 minutes ahead.
- Unknown props and fields are dropped, and the event is kept. `app` and every other top-level
  field are never stored.
- A string that could carry personal or work data drops its event (`pii_pattern`): a `/`, `\`, `@`
  or `~`, a URL scheme, an IP address, a host name, git ref syntax, a control character, or more than
  64 characters.

Drop reasons, counted in `telemetry_dropped_total{reason}` (per event, or 1 for a batch that never
got that far): `schema`, `too_large`, `type_unknown`, `pii_pattern`, `enum_unknown`, `rate_limited`,
`store_error`. Stored events count in `telemetry_accepted_total`.

## Limits

| Limit       | Per minute  | Key                                                                |
| ----------- | ----------- | ------------------------------------------------------------------ |
| Per address | 120 batches | HMAC-SHA-256 of the hour and the address under `TELEMETRY_IP_SALT` |
| Per install | 12 batches  | `install_id`                                                       |

Past either, the batch is dropped (`rate_limited`) and still answered 204. The keys live in Redis for
their 60 s window. The address is never stored or logged, and a key cannot be traced back to one.
When Redis cannot answer, batches are dropped.

B023's general rate limiter answers 429, so `TELEMETRY_ROUTE` must be on its exempt list.

## Storage

`telemetry_events` is partitioned by the UTC day a batch is received, one table per day
(`telemetry_events_YYYYMMDD`), created on demand. Its columns are `day`, `install_id`, `type`, `at`
and `props`: no address, user, device, workspace or request id. A batch is one INSERT, with a 1 s
statement timeout, so a slow database sheds telemetry instead of holding requests. A failed write
drops the batch (`store_error`).

## Retention

The worker's `telemetry-retention` queue:

| Job      | When            | What                                                                                       |
| -------- | --------------- | ------------------------------------------------------------------------------------------ |
| `rollup` | daily 00:10 UTC | Each day before today without a rollup is counted into `telemetry_daily_agg`, exactly once |
| `drop`   | daily 00:20 UTC | Day tables older than 90 days are dropped, after any missing rollup                        |

Rollups hold counts only: per day and type, `*` for every event, and `<prop>=<value>` for string and
boolean props (`name=login`, `ok=true`). Numbers are not kept after 90 days. A day is claimed in
`telemetry_rollups` in the same transaction as its counts, so running the job any number of times
counts it once. A run after missed runs catches up on every day.

## Configuration

| Key                          | Default | Meaning                                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------------------------- |
| `TELEMETRY_RETENTION_DAYS`   | `90`    | Days raw events are kept; anything but 90 is refused (CT-TELEMETRY)              |
| `TELEMETRY_BATCH_MAX_EVENTS` | `100`   | Most events in a batch (1-100)                                                   |
| `TELEMETRY_BATCH_MAX_BYTES`  | `65536` | Largest body (1 KiB-64 KiB)                                                      |
| `TELEMETRY_IP_SALT`          | random  | Secret salt (32+ characters) of the address keys; set the same on every instance |

## Not here

The client's opt-in, buffering and `DO_NOT_TRACK` handling, dashboards and analysis, the general
retention framework (B090, which reports this lane's retention), and the backend's own error
tracking (B093).
