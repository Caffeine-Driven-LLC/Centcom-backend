# Health and status

Lane B086 ([CT-STATUS](../../contracts/00-foundations.md)). The API answers three public,
unauthenticated endpoints: liveness, readiness, and the status feed clients use for banners. The
feed is informational: clients must never block local or LAN use because of it.

## `GET /healthz`

`200 {"status":"ok"}` whenever the process answers. It touches no dependency, so it stays 200 with
Postgres and Redis down (and answers in well under 5 ms). `Cache-Control: no-store`.

## `GET /readyz`

| Check        | Passes when                                                                        |
| ------------ | ---------------------------------------------------------------------------------- |
| `db`         | `SELECT 1` answers within `READYZ_TIMEOUT_MS` (1 s)                                |
| `redis`      | `PING` answers within 1 s                                                          |
| `migrations` | the newest applied migration is at least `EXPECTED_MIGRATION_VERSION` (within 1 s) |

All pass: `200 {"status":"ok","checks":{...}}`; otherwise `503 {"status":"degraded","checks":{...}}`.
Each check is `{"ok": true|false}`, never an error message, host, port or version. The checks run
at once, so the answer comes within about a second whatever hangs. A database ahead of the build
counts as ready (B007's rule, so a rolling deploy does not take old instances out); a missing
migrations table fails `migrations` only.

## `GET /v1/status`

```json
{
  "status": "degraded",
  "updated_at": "2026-11-04T12:00:00.000Z",
  "components": [{ "id": "relay-eu", "name": "Relay (EU)", "status": "degraded" }],
  "incidents": [
    {
      "id": "inc_01JA3Z8K2M5N7P9Q0R1S2T3V4W",
      "title": "Elevated latency",
      "status": "investigating",
      "started_at": "2026-11-04T11:00:00.000Z",
      "updates": [{ "at": "2026-11-04T11:30:00.000Z", "text": "We are looking into it." }]
    }
  ],
  "min_client_version": "1.2.0",
  "contract_version": "1.2.0",
  "deprecations": [{ "what": "/v1/foo", "sunset": "2027-03-01" }]
}
```

- `status` is the worst component's.
- `components` come from `STATUS_COMPONENTS`, each probed (below).
- `incidents` are the open ones and those resolved in the last 7 days, open first, newest first,
  each with its updates in order; at most 20.
- `min_client_version` is Redis `status:min_client_version` (written by the release service, B084),
  else `MIN_CLIENT_VERSION`. `contract_version` is the version of the contracts this build was
  generated from (`contracts/index.json`).
- `Cache-Control: public, max-age=15` and an `ETag`; `If-None-Match` gives 304.
- At most 32 KiB: when larger, the oldest updates of the incidents with the most are left out
  (each keeps its newest).
- It is always 200. Each instance builds the feed at most every 15 s. When a build fails (Postgres
  or Redis down), the last good feed is served for 5 minutes, its `updated_at` showing its age; then
  every component is `degraded` and a `status-data` component says the status data is unavailable.

### Components and probes

```json
[
  { "id": "api", "name": "API" },
  {
    "id": "relay-eu",
    "name": "Relay (EU)",
    "probe": { "url": "https://relay-eu.internal/readyz" }
  },
  {
    "id": "jobs",
    "name": "Background jobs",
    "probe": { "heartbeat_key": "worker:heartbeat", "max_age_s": 60 }
  }
]
```

- A `url` probe is up when a GET answers 2xx within 2 s; a `heartbeat_key` probe when the Redis key
  holds a time (epoch milliseconds) at most `max_age_s` old; no probe is always `operational`.
- One failure makes a component `degraded`, three in a row `major_outage`; it is `operational`
  again after two successes in a row.
- Across all API instances, a component is probed at most once every 15 s: an instance probes only
  when it wins `status:probe:{id}` in Redis (15 s), and the result with its counters is shared in
  `status:probe-state:{id}`.
- Probe URLs and keys never appear in a response.

## Incidents and deprecations

`StatusAdmin` (B087's admin tooling calls it; there is no HTTP route here):

| Call                                             | Does                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `createIncident({title, component_ids, status})` | Opens an incident (`inc_` id) on configured components                   |
| `addIncidentUpdate(id, text, status?)`           | Adds an update; a status changes the incident's (`resolved` resolves it) |
| `resolveIncident(id)`                            | Resolves it (it leaves the feed 7 days later)                            |
| `setDeprecation({what, sunset})`                 | Lists a deprecation, or moves its sunset date                            |

Statuses: `investigating`, `identified`, `monitoring`, `resolved`. Titles are at most 120
characters and update text at most 500, and neither may hold an e-mail or IP address or a
credential: incidents are public, so they must never carry customer data.

## Configuration

| Key                          | Default                  | Meaning                                        |
| ---------------------------- | ------------------------ | ---------------------------------------------- |
| `STATUS_COMPONENTS`          | `[]`                     | JSON array of components (at most 50)          |
| `MIN_CLIENT_VERSION`         | `0.0.0`                  | `min_client_version` when Redis has none       |
| `READYZ_TIMEOUT_MS`          | `1000`                   | Time limit of each readiness check (100-5 000) |
| `EXPECTED_MIGRATION_VERSION` | this build's newest file | The migration version `/readyz` requires       |

Metrics: `status_probes_total{component,ok}`, `status_feed_build_failures_total`.

## Not here

`/.well-known/jwks.json` (B017), the relay's own health (B037), admin endpoints and UI for
incidents (B087, B088), alerting and SLOs (B093, B094), and `client_too_old` enforcement.
