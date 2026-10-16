# Credential-leak guard (B101)

Finds provider credentials (the patterns of `contracts/fixtures/providers/secret-patterns.json`:
Anthropic and OpenAI keys, OpenAI/Codex OAuth tokens and `auth.json` fields, Bearer headers, AWS
and Google keys) where they must never be: logs, REST requests, WebSocket frames, telemetry,
backups and the repository. A hit is `{pattern, offset, length}`; the matched text, a prefix, a
suffix or a hash of it is never logged, returned, labelled or stored.

```ts
import { secretGuard } from '@centcom/core';
```

| Surface   | Entry point                                       | On a hit                                               | Mounted by           |
| --------- | ------------------------------------------------- | ------------------------------------------------------ | -------------------- |
| log       | `createGuardedLogger(base, {metrics})`            | redact to `[redacted:<id>]`, count, warn (ids only)    | each service's main  |
| REST      | `app.addHook('preValidation', secretGuardHook())` | `400 invalid_request` (same body for every pattern)    | `apps/api` app setup |
| frame     | `guardFrame(frame)`                               | `{ok:false, code:'invalid_frame'}` -> `sys.error`      | relay frame pipeline |
| telemetry | `guardTelemetryBatch(events)`                     | event dropped, the rest kept, response stays 204       | telemetry ingest     |
| backup    | `backupScanHook(stream, {artefact})`              | `quarantined: true`; a read error is `scan_incomplete` | B099 backup/restore  |
| CI        | `pnpm secret-guard:scan [--logs d] [--dump f]`    | exit 1, `path:line pattern-id`                         | CI (workflow to add) |

**Mounted** (follow-up of the lane, tests in `apps/api/test/secret-guard`, `apps/relay/test/secret-guard`, `infra/dr/scan.test.ts`):
the API logger and REST hook (`createContext`, `buildApp`), the relay logger and a frame stage of order 31
(`apps/relay/src/secret-guard`), the telemetry ingest, and `backup.sh` / `restore.sh` through
`apps/api/src/scan-stream.ts`. Not mounted: the CI log and dump scan (a workflow, `.github/` is protected).

## Rules the code keeps

- **Ciphertext is never read.** Frames reach the scanner only through `stripCiphertext`, which
  copies every key but `ct` and `sig` without reading those two. The module imports no crypto and
  holds no key (`ciphertext.test.ts` checks the sources).
- **Reject surfaces fail closed.** If the scanner throws, a REST request or frame is rejected, a
  telemetry event dropped. A request over its 20 ms scan budget, or with more than 100,000 values, gets `413 payload_too_large`. The
  logger fails open: unscannable fields become `[unscannable]` and the line is still written.
- **False positives** are handled only by `secret-guard.allow.json`: a pattern id plus a location
  (`path`, `route`, `log_component`), a reason and an expiry, at most 20 entries. No entry can name
  content. An entry without a reason, past its expiry or with an unknown field makes loading throw.
- **Speed.** Each pattern has trigger text that must be present before its regex runs; 1 MiB of
  ordinary log lines scans in about 7 ms (budget 51 ms). The JWT pattern is matched by a linear
  walk because its regex is quadratic on `eyJeyJ...`; a property test keeps the two equal.
- **Redaction is stable.** `redactText` repeats until the output has no match (a marker can expose
  a key that was glued to the one it replaced).

## Configuration (B004)

`SECRET_GUARD_ENABLED` (default true; false only with `NODE_ENV=test`), `SECRET_GUARD_MAX_BODY_BYTES`
(default 1 MiB), `SECRET_GUARD_ALLOW_FILE` (path of the allow-list). `secretGuardConfig(env)`.

## Metrics and alerts

`centcom_secret_guard_hits_total{surface,pattern}` and `centcom_secret_guard_scan_seconds{surface}` (recorded as `secret_guard_hits_total` and `secret_guard_scan_seconds`; the metrics bridge adds the prefix).
A hit on `rest`, `frame`, `telemetry` or `backup` pages the on-call (a client bug or an attack); a
`log` hit opens a ticket. Alert rules live with B094; the rule texts are not part of this lane.

## Updating the patterns

Patterns are a contract change. After it, run `pnpm --filter @centcom/core gen:secret-patterns`
(`patterns.test.ts` fails while `patterns.generated.ts` and the contract file differ) and add the
new pattern's trigger text to `TRIGGERS` in `patterns.ts` (start-up throws without it).
