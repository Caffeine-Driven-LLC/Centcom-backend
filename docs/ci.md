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
| `security / secrets`  | gitleaks 8.30.1 over the full git history                                  | anything shaped like a secret                                                                                     |
| `security / codeql`   | CodeQL (JavaScript/TypeScript)                                             | **skipped** until enabled (see below)                                                                             |
| `pr-title / pr-title` | `tools/ci/check-lane-title.mjs`                                            | the title does not start with `B###: `                                                                            |

The required set from the B002 card is `ci / typecheck`, `ci / lint`, `ci / test`,
`ci / build`, `ci / contract-lock`, `security / audit`, `security / secrets`,
`security / codeql` and `pr-title`.

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

Set it only after Code Security is enabled for the repository (or the repository becomes public).

## Supply chain

- Dependencies: exact pins (`pnpm lint`), `pnpm install --frozen-lockfile`, no lifecycle scripts,
  and pnpm's 24 h `minimumReleaseAge` in strict mode (B001).
- Dependabot: alerts and security updates are enabled in the repository settings;
  `.github/dependabot.yml` turns routine version-update PRs off (`open-pull-requests-limit: 0`).
  Dependabot PRs skip the `pr-title` check because they are not lanes.
- gitleaks: the official GitHub Action needs a licence key for organisation repositories, so the
  workflow downloads the MIT-licensed CLI release and verifies its SHA-256 before running it.
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

## Local equivalents

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
python3 tools/plan/lock.py --check
node tools/ci/check-licences.mjs
node tools/ci/check-lane-title.mjs "B002: CI pipeline"
```

## Dry runs

Recorded when B002 was built (scratch pull requests, closed without merging):

<!-- dry-run-results -->
