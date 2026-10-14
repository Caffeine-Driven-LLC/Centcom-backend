# Provider conformance suite and release gate

Lane B100. One command runs the tests that prove each contract the backend implements, a second set of
commands runs the provider-side integration gates, and a sixth checks that all the other evidence is fresh and
green. Everything lives in [`infra/conformance/`](../../infra/conformance/).

## Commands

| Command                                                          | What it does                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm conformance [--only CT-A,CT-B] [--strict] [--report file]` | Runs the 28 backend contracts' test sets (about 4 900 cases, 8 minutes) and every `contracts/fixtures/events/*.json`, writes `conformance-report.json`.                                                                                             |
| `pnpm gate:g1` ... `pnpm gate:g5`                                | Runs one gate's test set and appends `{id, status, checks}` to the report's `gates` section. Each takes a few minutes.                                                                                                                              |
| `pnpm gate:g6`                                                   | Aggregates evidence: a fresh (under 24 h) green conformance report with G1 to G5 passed, the six load reports, a chaos report, `pnpm security:deps`, a verified restore drill under 35 days old, `pnpm alerts:lint`, the release-manifest fixtures. |

All of them need Postgres and Redis (`DATABASE_URL` and `REDIS_URL`, or Docker). Exit codes: 0 pass, 1 any
failure, 2 usage, 3 `--strict` with a contract that has no fixtures or did not run. Low parallelism is kinder
to a shared machine: `VITEST_MAX_WORKERS=2`.

## How a contract is judged

`infra/conformance/map.ts` lists, for every contract `contracts/index.json` says the backend implements, the test
files or folders that prove it and the fixture folders they consume. A unit test fails when a backend contract has
no entry, an entry names a path that does not exist, or the map names a contract the backend does not implement,
so adding a contract forces an update here. The runner executes all those paths in one vitest process and files
every test case under the contracts that own its file. A contract is

- `pass` when its cases passed and none failed,
- `fail` when any case failed, a file failed to load, or **nothing but skips ran** (a suite that skipped itself for
  lack of Postgres is never reported green),
- `missing_fixtures` when a fixture folder it consumes is empty (exit 3 under `--strict`).

`CT-WS-SESSION-EVENTS` also gets one case per event fixture (48 today): the frame and its secret payload must
validate against `events.schema.json`, and a count that differs from the directory fails the contract.

The report (`conformance-report.json`) has the shape of the card: `summary`, `contracts[].cases[]` with the error
message and a file pointer for a failure, and `gates[]`. Running twice on one commit gives the same summary and
case names (only times differ). `reportProblems()` checks a report's structure and that its summary adds up.

## Gates

G1 to G5 run these sets (see `GATE_TESTS` in `map.ts`) and pass when no case failed and at least one passed:

| Gate | Set                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| G1   | Device sign-in end to end on Postgres (mailed link, approve, poll, tokens, `/v1/me`, refresh, revoke), device flow tests |
| G2   | Relay handshake, heartbeat and state machine, resume and replay, sequencing, graceful shutdown                           |
| G3   | Queue, approvals, fan-out of opaque ciphertext, and the privacy suite (canary values absent from logs and metrics)       |
| G4   | Billing end to end (checkout, signed webhook, processing, plan and entitlements), enforcement, quotas, usage             |
| G5   | Branch mode, file locks, presence, notifications, outgoing webhooks with signatures                                      |

## What this is not (honest list)

- **Not the card's simulator-driven scenarios.** The card describes G2 to G5 as scripts that start a relay and
  drive it with two or three client simulators. These gates run the repository's strongest existing suites for each
  gate instead; the relay round trip of every event fixture through a live relay is not done (the fixtures are
  schema-checked here and exercised by the relay's own tests).
- **No `--target stage`** (there is no stage environment) and no `release-gate.yml`: `.github/` is a protected
  path. To wire it, a human adds a job that runs `pnpm conformance --strict` and `pnpm gate:g1` to `gate:g6` on pull
  requests to main with Postgres and Redis service containers and uploads `conformance-report.json`.
- **No REST authorization matrix generated from the contract tables.** Role-by-route matrices exist in the lanes'
  own tests (RBAC matrix, checkout authz, and so on) and run as part of their contracts.
- **G6 is only green when every file exists.** The chaos report comes from `CHAOS_REPORT=chaos-report.json pnpm
chaos` (see [failure modes](../ops/failure-modes.md)), the drill report from `pnpm dr:drill`; both must be in
  the folder G6 runs in.
- Timing tests (`*.perf.test.ts`, benchmarks run in their own process) can fail on a loaded machine and then
  fail their contract; re-run the one contract with `--only`.
