# Feature flags and remote config

Lane B083 ([CT-API-FLAGS](../../contracts/02-rest-api.md)). Clients read their flags from
`GET /v1/flags`; server code asks `isEnabled`; staff change flags through the admin API that B087's
tooling calls. Flags are configuration: they never grant a paid feature. Entitlements
(CT-ENTITLEMENTS) and RBAC stay the only gates.

## The endpoint

`GET /v1/flags`, anonymous or with a bearer credential.

```json
{ "flags": { "banner": true, "theme": "dark", "limits": { "queue": 50 } }, "rev": 42, "ttl_s": 60 }
```

| Caller                                     | Gets                                                         | `Cache-Control`          |
| ------------------------------------------ | ------------------------------------------------------------ | ------------------------ |
| No `Authorization`                         | `public` flags without percent, plan or workspace rules      | `public, max-age=30`     |
| User token with scope `profile`            | Every flag but `server_only` ones, evaluated for the user    | `private, max-age=<ttl>` |
| API key, or a user token without `profile` | What an anonymous caller gets (there is no user to evaluate) | `private, max-age=<ttl>` |
| A credential that does not verify          | 401 (`unauthorized`, `token_expired`, `token_invalid`, ...)  |                          |

- Every answer has an `ETag` (the revision and a digest of the body) and
  `Vary: Authorization, User-Agent`. `If-None-Match` with the current ETag is 304 with no body.
- The body holds keys and values only: never rules, rollout buckets, workspace ids or plans.
- `rev` is global: it goes up by exactly 1 with every change.

## Defining a flag

```json
{
  "key": "relay.compression",
  "type": "string",
  "value": "zstd",
  "default": "none",
  "public": false,
  "server_only": false,
  "kill": false,
  "rules": [
    { "type": "plans", "plans": ["pro", "team"] },
    { "type": "client_version", "min": "1.2.0" },
    { "type": "percent", "percent": 25 }
  ]
}
```

| Field         | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `key`         | `[a-z0-9_.-]{1,64}`. No segment may name a secret (`secret`, `token`, `key`, `password`, ...) |
| `type`        | `bool`, `string`, `number` or `json` (an object)                                              |
| `value`       | Served when every rule passes; at most `FLAGS_MAX_VALUE_BYTES` (2 048) bytes of JSON          |
| `default`     | Served otherwise, and to everyone while `kill` is set                                         |
| `public`      | May be shown to anonymous callers (only without percent, plan or workspace rules)             |
| `server_only` | Never sent to clients; for `isEnabled` only                                                   |
| `kill`        | Kill switch: the default for everyone, whatever the rules                                     |
| `rules`       | At most one of each kind, all of which must pass                                              |

| Rule                                   | Passes when                                                               |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `{type: 'percent', percent}`           | the user's bucket for this flag is below `percent` × 100 (two decimals)   |
| `{type: 'plans', plans}`               | the token's plan (`free`, `pro`, `team`) is listed                        |
| `{type: 'workspaces', workspaces}`     | the token's active workspace is listed (at most 1 000 ids)                |
| `{type: 'client_version', min?, max?}` | the client's version is within `[min, max]`; otherwise the flag is hidden |

Values must not hold secrets or personal data: strings that look like a credential, a JWT, an
e-mail address or an IP address are refused.

### Evaluation order

1. Shown at all? Never a `server_only` flag; anonymous callers only `public` flags without
   per-caller rules; a flag with a version rule is hidden from a client whose version is unknown
   or out of range (unless it is killed).
2. Kill switch: the default.
3. A stored rule this version of the API does not know: the default (counted in
   `flags_rule_errors_total`; the answer still succeeds).
4. Plan, workspace, percentage: all must pass for the value; else the default.

### Percentage rollouts

A user's bucket for a flag is the first 32 bits of SHA-256 over `<key>:<usr_ id>`, modulo 10 000.
The same user is always in the same bucket for a flag; different flags bucket independently;
raising the percentage only adds users. Renaming a flag reshuffles its rollout.

### Client versions

From `User-Agent: centcom-cli/1.4.2 (contract/1.0.0; linux-x64; node/22.9.0)` (CT-VER), any
`centcom-<product>/<semver>`. Versions compare by SemVer 2.0 (`1.2.0-rc.1` is before `1.2.0`). Any
other header, or none, is an unknown version.

## Changing flags

The admin API (no HTTP route yet; B087 adds one):

- `setFlag(def, actor)` creates or replaces a flag and returns `{rev}`.
- `deleteFlag(key, actor)` returns `{rev}`, or 404.
- `listFlags()` returns every definition with `updated_by` and `updated_at`.

Each change, in one transaction: the definition, the revision + 1, and an audit event (`flag.set` or
`flag.delete`, outside any workspace) with the actor, the flag's key, the new revision and the hex
SHA-256 of the previous definition. Values never reach the audit log. Then the revision is
published on Redis `flags:inv`.

Refused with 422: a bad definition; a value over `FLAGS_MAX_VALUE_BYTES`; a new flag past
`FLAGS_MAX_COUNT` (500); a definition that would take the answer past 64 KiB (`server_only` flags
do not count).

## Freshness and failure

| Situation                     | Effect                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| A flag changes                | Every API process reloads on `flags:inv`, within a second                          |
| The message is lost           | Each process reads the revision every 15 s and reloads when it differs             |
| Cache and database disagree   | The cache is discarded and reloaded at the next poll (at most 15 s stale)          |
| Postgres down                 | The last good set is served, same ETags, for 5 minutes after it was last confirmed |
| ... for longer than 5 minutes | 503 `service_unavailable` with `retry_after_s: 5` until Postgres is back           |
| Unknown stored rule           | That flag serves its default; `flags_rule_errors_total` counts it                  |
| Corrupt `User-Agent`          | Treated as an unknown version                                                      |

Answers never read Postgres: 500 flags answer well within 20 ms at the 95th percentile.

## Configuration

| Key                     | Default | Meaning                                                  |
| ----------------------- | ------- | -------------------------------------------------------- |
| `FLAGS_TTL_S`           | `60`    | `ttl_s` and `max-age` of authenticated answers (5-3 600) |
| `FLAGS_MAX_COUNT`       | `500`   | Most flags stored (1-500)                                |
| `FLAGS_MAX_VALUE_BYTES` | `2048`  | Largest value or default, in bytes of JSON (16-2 048)    |

Metrics: `flags_refresh_failures_total`, `flags_rule_errors_total`, `flags_publish_failures_total`.

## Not here

The admin UI and HTTP endpoints (B087, B088), gating backend code paths (other lanes call
`isEnabled`), experiment analytics and exposure logging.
