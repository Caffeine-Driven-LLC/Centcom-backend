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
Claude Code session opens overnight can land without a human. Every trigger (a push, a finished
`ci`/`security`/`pr-title` run, a dispatch, or the 30-minute sweep) re-reads the PR, and
`tools/ci/claude-pr-state.mjs` picks one step, in this order:

| State of the head SHA                                        | Step                                      |
| ------------------------------------------------------------ | ----------------------------------------- |
| not opted in, draft, fork, `do-not-merge`, changes requested | skip                                      |
| touches a CODEOWNERS path (except `plan/STATUS.json`)        | hand off to a human                       |
| conflicts with main                                          | Claude merges main, resolving conflicts   |
| a required check failed                                      | Claude reads the log and fixes the code   |
| no `claude-review` status                                    | Claude reviews; fixes blocking findings   |
| approved, checks still running                               | wait                                      |
| approved, green, behind main                                 | first in the queue: merge main; else wait |
| approved, green, up to date                                  | squash-merge, one PR at a time            |

- **Review rounds:** Claude approves only a commit it did not write; when it pushes fixes, the
  next run reviews them. Nits are comments only. After three Claude fix commits (titles ending
  `(claude)`) it reviews without fixing, and anything still failing goes to a human.
- **Handoff:** the PR gets `claude-needs-human` and a comment saying why. Remove the label after
  dealing with it to put the PR back in the pipeline.
- **Pause:** set the repository variable `CLAUDE_AUTOMERGE` to `off`.
- **Merge queue:** when several ready PRs are behind main, only the lowest-numbered one merges main
  (a clean merge keeps its approval); the others wait, so CI does not re-run on all of them after
  every merge.
- **Shared with Centcom:** the scripts and prompts are identical in both repositories;
  `tools/ci/claude-pr.config.json` holds this repository's checks, lane pattern and gates.
- **Dependencies** may merge unattended: CI enforces exact pins, the 24 h release age, the
  licence allow-list and the audit. `pnpm-workspace.yaml`, which holds those settings, may not.
- **Local sessions** follow the lane loop in [`CLAUDE.md`](../CLAUDE.md): open the PR, add the
  label last, then wait with `node tools/ci/claude-pr-wait.mjs <pr>` (exit 0 merged, 2 handed off,
  3 closed, 4 timed out, 5 not opted in).
- **Merges** use `GITHUB_TOKEN`, which starts no `push` workflows, so the pipeline dispatches `ci`
  and `security` on `main` after each merge.

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
