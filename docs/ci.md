# CI

Owner: lane B002. Every pull request runs the workflows below. Third-party actions are pinned to
full commit SHAs, every workflow defaults to `permissions: contents: read`, and no workflow uses
`pull_request_target`, so fork PRs never see secrets.

## Status checks

| Check                 | Workflow job                                                               | Fails when                                                                                                        |
| --------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ci / typecheck`      | `pnpm typecheck`                                                           | a type error in sources, tests or scripts                                                                         |
| `ci / lint`           | `pnpm lint`                                                                | an ESLint error or a dependency version range                                                                     |
| `ci / test`           | `pnpm test`                                                                | a failing test or line coverage under 80 %                                                                        |
| `ci / build`          | `pnpm build`                                                               | `tsc -b` fails                                                                                                    |
| `ci / integration`    | `pnpm test` with Postgres 16 and Redis 7                                   | a service is not healthy within 60 s, or a test fails                                                             |
| `ci / contract-lock`  | `tools/plan/lock.py --check` + diff against the PR base                    | any byte of `contracts/` changes (including the lock)                                                             |
| `security / audit`    | `pnpm audit --prod --audit-level high`, then `tools/ci/check-licences.mjs` | a high/critical advisory, an unreachable audit service, or a production licence outside MIT, Apache-2.0, BSD, ISC |
| `security / secrets`  | gitleaks 8.30.1 over the history reachable from the PR                     | anything shaped like a secret                                                                                     |
| `security / codeql`   | CodeQL (JavaScript/TypeScript)                                             | **skipped** until enabled (see below)                                                                             |
| `pr-title / pr-title` | `tools/ci/check-lane-title.mjs`                                            | the title does not start with `B###: `                                                                            |

**Required checks today:** `ci / typecheck`, `ci / lint`, `ci / test`, `ci / build`,
`ci / integration`, `ci / contract-lock`, `security / audit`, `security / secrets` and
`pr-title / pr-title`.

**`security / codeql` is not a required check yet**, although the B002 card lists it. While the
job is gated off it reports _skipped_, and GitHub treats a skipped required check as passing, so
listing it would claim a scan that is not running. Add it to the required set in the same change
that sets `CODEQL_ENABLED` (below).

### Branch protection is not available yet

The organisation is on GitHub Free and the repository is private. On that plan GitHub rejects
branch protection and rulesets (`HTTP 403: Upgrade to GitHub Pro or make this repository public`),
so the checks above **report** but cannot **block** a merge, and CODEOWNERS reviews are not
enforced. Until the plan changes, reviewers must not merge a PR with a red required check. Once
protection is available, set the list above as required status checks on `main`, require one
approving review from a code owner, and block force pushes.

### CodeQL is off until Code Security is licensed

The CodeQL licence permits analysing code that is not open source (for example, a private repo)
only under a paid GitHub Advanced Security / Code Security licence. The `codeql` job therefore runs
only when the repository variable `CODEQL_ENABLED` is `true`:

```bash
gh variable set CODEQL_ENABLED --body true --repo Caffeine-Driven-LLC/Centcom-backend
```

Set it only after Code Security is enabled for the repository (or the repository becomes public),
and add `security / codeql` to the required checks at the same time. Until then the repository has
**no static analysis (SAST)** beyond ESLint; B097 (security hardening) should revisit this.

## Supply chain

- Dependencies: exact pins (`pnpm lint`), `pnpm install --frozen-lockfile`, no lifecycle scripts,
  and pnpm's 24 h `minimumReleaseAge` in strict mode (B001).
- Dependabot: alerts and security updates are enabled in the repository settings;
  `.github/dependabot.yml` turns routine version-update PRs off (`open-pull-requests-limit: 0`).
  Dependabot PRs skip the `pr-title` check because they are not lanes.
- gitleaks: the official GitHub Action needs a licence key for organisation repositories, so the
  workflow downloads the MIT-licensed CLI release and verifies its SHA-256 before running it.
  It scans only history reachable from the checked-out commit (`--log-opts="HEAD"`); by default
  gitleaks walks every fetched branch, which made one branch's leak fail every PR.
- `.gitleaksignore` accepts findings by exact fingerprint (commit, file, rule, line):
  - six deliberate test values: the CT-CRYPTO known-answer vectors and the fake AWS keys used by
    the B101 leak-guard fixtures
  - two false positives in a superseded B003 branch commit, kept so that branch's history scans
    clean

  Add an entry only for a deliberate test value, or for a false positive that has already been
  fixed at the source, with a comment saying why. Never add one for a real key: rotate it and purge
  history instead. Because the scan covers history, a fixed false positive still fails its branch
  until the old commit is ignored or rewritten.

- Cache: only the pnpm store is cached (by `actions/setup-node`); nothing containing `.env` files
  or secrets is cached.

## Failure modes and re-runs

- **Audit service unreachable:** `pnpm audit` exits non-zero and the job stays red (fails closed).
  Re-run the job from the Actions tab once the npm registry is reachable; do not merge on red.
- **Service container unhealthy:** the integration job fails during container setup after 60 s and
  prints the container log there. `tools/ci/wait-for-services.mjs` then confirms both URLs accept TCP
  connections before tests run.
- **Lock tool missing:** `ci / contract-lock` fails with a message naming `tools/plan/lock.py`.
- **Contract PRs** (GUIDELINES §9) fail `ci / contract-lock` by design; they are merged by the plan
  leads after the Contract PR process, not by a lane.
- **Plan PRs** (titles without a lane ID) fail `pr-title` by design; the same applies.

## Claude PR pipeline (`claude-pr.yml`)

Reviews, fixes and merges lane PRs labelled `claude-automerge`, so PRs that an unattended local
Claude Code session opens overnight (see [`CLAUDE.md`](../CLAUDE.md)) can land without a human.
Every trigger re-reads the PR, and `tools/ci/claude-pr-state.mjs` picks one step:

| State of the head SHA                                                | Step                                        |
| -------------------------------------------------------------------- | ------------------------------------------- |
| not opted in, draft, fork, `do-not-merge`, a standing change request | skip                                        |
| touches a protected path, or its files cannot all be listed          | hand off to a human                         |
| conflicts with main                                                  | merge main; Claude resolves real conflicts  |
| a required check failed                                              | Claude reads the job log and fixes the code |
| no `claude-review` status from this pipeline                         | Claude reviews; fixes blocking findings     |
| approved, checks still running                                       | wait                                        |
| approved, green, behind main                                         | first in the queue: merge main; others wait |
| approved, green, up to date                                          | squash-merge, one PR at a time              |

Protected paths are `protectedPaths` and `protectedNames` in `tools/ci/claude-pr.config.json`:
`contracts/`, `plan/` (a lane may only modify `plan/STATUS.json`), `.github/`, `tools/plan/`,
`tools/ci/`, `pnpm-workspace.yaml`, Claude's own configuration (`CLAUDE.md` anywhere, `.claude/`,
`.mcp.json`) and the package-manager hooks (`.npmrc`, `.pnpmfile.*`). Renames count on both sides.

**How it fits together**

- **Triggers.** PR events go through `claude-pr-trigger.yml`, which only relays them, so
  `claude-pr.yml` always runs as it is on main and a PR cannot change the pipeline that judges it.
  Finished `ci`/`security`/`pr-title` runs on `lane/` branches, dispatches, and a sweep every four
  hours also re-plan. Every run re-derives the step, so a lost event only costs time.
- **Reviews run no PR code.** A review job installs nothing and Claude may not run builds or tests,
  so the code under review cannot forge the verdict. Fix and conflict-resolution jobs may run the
  gates, but their results never approve anything: Claude approves only a commit it did not write,
  and its fixes are reviewed by the next run after CI has checked them. Nits are comments only.
- **The record job** writes `claude-review` on the planned head. It runs no PR code, and the merge
  gate only accepts a `claude-review` posted by this pipeline (`github-actions[bot]`). A merge of
  main keeps an approval only if the merged head's changes against main equal the approved
  commit's changes against their merge base (checked by patch-id, outside Claude's job).
- **Fix rounds.** After three Claude fix commits (subjects ending `(claude)`), Claude reviews
  without fixing and anything still failing goes to a human.
- **Merge queue.** When several approved PRs are behind main, only the lowest-numbered one merges
  main; the others wait, so CI does not re-run on all of them after every merge. Merges happen one
  at a time.
- **Progress bookkeeping.** Lane PRs do not touch `plan/STATUS.json`, README's progress block or
  `docs/progress.svg`. After each merge the merge job marks the PR's lanes merged in
  `plan/STATUS.json` on main and regenerates the other two. When an older PR conflicts in those
  files, `tools/ci/claude-pr-bookkeeping.mjs` resolves them without Claude.
- **Merges** use `GITHUB_TOKEN`, which starts no `push` workflows, so the merge job dispatches `ci`
  and `security` on main itself.
- **Tripwire.** A push to main by the Claude App means something bypassed the merge gate; the
  workflow opens an issue and fails.
- **Shared with Centcom.** The scripts and prompts are identical in both repositories;
  `tools/ci/claude-pr.config.json` holds each repository's checks, lane pattern and gates.

**Setup** (once per repository)

1. The official Claude GitHub App is installed on the organisation (all repositories). An
   organisation owner approves any new permissions it asks for.
2. Repository secret `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` (a Pro or Max plan; the
   token lasts a year and uses that person's Claude limits). Organisation secrets do not reach
   private repositories on GitHub Free. To use an API key instead, store `ANTHROPIC_API_KEY` and
   change the action's `claude_code_oauth_token` input to `anthropic_api_key`.
3. Labels `claude-automerge`, `claude-needs-human` and `do-not-merge` (the pipeline creates
   `claude-needs-human` itself if it is missing).
4. Optional repository variable `CLAUDE_AUTOMERGE`: `off` pauses every decision. Runs still start
   (and bill a minute each); `gh workflow disable claude-pr.yml` stops them too.

**Costs.** GitHub Free gives the organisation 2,000 Actions minutes a month for private
repositories, each job billed as at least one minute, and the organisation's budget is $0, so
running out stops all CI until the month resets. Expect about 1 minute per plan (one per relayed
PR event, per finished CI workflow on a lane branch, and per re-dispatch by the sweep, a merge or
a local waiter, which re-dispatches a quiet PR every 20 minutes), up to 25 minutes per Claude job
plus the record job, plus normal CI. The sweep itself costs about 180 minutes a month, plus a plan
per actionable PR it re-dispatches. Check usage in the organisation's billing
settings, and raise the Actions budget if overnight runs are routine.

**When Claude hands a PR to a human**, the PR gets `claude-needs-human` and a comment naming the
reason. Removing the label re-plans the PR at once, so deal with the reason first:

- _Protected paths, or files that could not be listed:_ a human reviews and merges it.
- _Claude's review rejected the head SHA:_ push a fix (it gets a fresh review), or merge it by hand
  if you disagree. A `claude-review` status you post yourself does not count: the gate accepts
  only this pipeline's.
- _Out of fix rounds with a check still failing:_ push a fix, or re-run a flaky job until it is
  green; then remove the label.
- _Anything else_ (a failed Claude step, whose comment quotes Claude's error, a fix-ci or conflict
  answer, a push that never landed):
  deal with the cause, then remove the label; the pipeline picks up from the PR's current state.

To take a PR out of automation, add `do-not-merge` (a local session never touches that label).

GitHub runs no `pull_request` workflows on a PR with merge conflicts, so labelling a conflicting
PR is not relayed: re-plan it with `gh workflow run claude-pr.yml -f pr=<n>`, or wait for the
sweep or a local waiter.

## Local equivalents

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
python3 tools/plan/lock.py --check
node tools/ci/check-licences.mjs
node tools/ci/check-lane-title.mjs "B002: CI pipeline"
```

## Dry runs

Recorded on 2026-10-06 while B002 was built. Each case is a scratch pull request into the B002
branch (#3 to #6, never merged). On the B002 branch itself every check passed (CodeQL skipped).
Each dependency case uses an exact pin, so the only red check is the gate under test.

| Case                                            | PR  | Expected                                 | Result                                                                                                                   | Other red checks                                      |
| ----------------------------------------------- | --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| One byte added to `contracts/00-foundations.md` | #3  | `ci / contract-lock` fails within 2 min  | failed in 7 s (`DRIFT 00-foundations.md`)                                                                                | `ci / test`, `ci / integration` (expected, see below) |
| Fake AWS access key in a new file               | #4  | `security / secrets` fails               | failed (`aws-access-token`, `generic-api-key`)                                                                           | none; PR closed and branch deleted afterwards         |
| `glpk.js@5.0.0` (GPL-3.0) in `apps/api`         | #5  | licence step of `security / audit` fails | `pnpm audit` passed; licence step failed naming `glpk.js@5.0.0 (GPL-3.0)` and its dependency `pako@2.2.0 (MIT AND Zlib)` | none                                                  |
| `ms@2.1.3` (MIT) in `apps/api`                  | #6  | `security / audit` passes                | passed                                                                                                                   | `pr-title` only (next row)                            |
| Title without a lane ID                         | #6  | `pr-title` fails                         | failed                                                                                                                   | none                                                  |

In #3, `ci / test` and `ci / integration` also fail, and that is expected: the repo test
`contracts:check runs the contract lock check` (tools/repo/repo-layout.test.ts) runs
`tools/plan/lock.py --check`, which fails on the edited contract. It is the same failure seen
through the test suite, not a separate problem.

`pako` is flagged because `Zlib` is not on the allow-list (GUIDELINES §3.9 lists MIT, Apache-2.0,
BSD and ISC). Zlib is a permissive licence; adding it would be a GUIDELINES change, not a CI one.

### Timing and cache (acceptance 5)

- First run, cold cache: the `security / audit` job (run 37482920063) found no pnpm-store cache, installed, and
  its post step logged `Cache saved with the key: node-cache-Linux-x64-pnpm-918787f7…`.
- Every later run restored that key, for example `ci` run 37483154266: `Cache restored from key:
node-cache-Linux-x64-pnpm-918787f7…` and `Cache hit occurred on the primary key …, not saving cache`
  in each job. The key changes only when `pnpm-lock.yaml` changes.
- The whole `ci` workflow took 67 s on the B002 branch (limit 10 min).

The integration job logged `postgres service is healthy.` and `redis service is healthy.` before any
step ran, then `DATABASE_URL: localhost:5432 reachable.` and `REDIS_URL: localhost:6379 reachable.`

The dry runs found two bugs, fixed before merge:

- `pnpm licenses list` without `-r` reports only the root package, so the GPL dependency in
  `apps/api` passed. The check now lists every workspace package.
- gitleaks walked every fetched branch, so the fake key from #4 failed the secret scan on every
  other PR. The scan is now limited to history reachable from `HEAD`.
