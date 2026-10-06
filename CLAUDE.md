# Claude Code in Centcom-backend

Start with `plan/START_HERE.md`, `plan/GUIDELINES.md` and the lane card you are building. Lane
cards are `plan/lanes/backend/B###.json`. Contracts in `contracts/` win over cards (GUIDELINES
§2.2).

## Lane loop

Lanes are built one at a time, by one session. After opening a PR, the session waits until the
Claude PR pipeline (`.github/workflows/claude-pr.yml`, described in `docs/ci.md`) reviews and
merges it, then starts the next lane, so each lane builds on merged work. The pipeline reviews,
fixes and merges. This session never merges and never approves its own PR.

### 1. Pick the next lane

Start with `gh pr list --state all --limit 200 --json number,title,state`, then
`git fetch origin main` (in that order, so a PR that merges in between still shows up in one of
them). A lane is **done** if any of these holds:

- a subject line in `git log origin/main --format=%s` carries its ID;
- a merged PR's title carries its ID;
- its entry in `plan/STATUS.json` on origin/main has `pct` 0.95 or more.

A lane is **eligible** when all of these hold:

- it is not done, and its `pct` is 0 or absent (a partly built lane needs a human to decide how to
  finish it: skip it and list it in the report);
- every lane in its `depends_on` is done;
- no open PR covers it, and it was not closed earlier in this run. An open PR also covers a lane
  that was handed to a human, and so blocks everything that depends on it;
- none of its `deliverables` sit under a protected path (see Rules), and its `acceptance` and
  `scope_in` do not require a new or changed workflow, CI job or schedule that a test cannot
  provide. Leave those lanes for a session a human is watching.

Take eligible lanes in the order their IDs first appear in the `next` titles of `plan/STATUS.json`
(a range such as `B004-B006` counts as each ID in it), then by lowest ID. If none is eligible,
stop and report.

### 2. Build it

1. `git checkout main && git pull --ff-only`, then branch `lane/B###-short-slug`.
2. Build only the card's `deliverables`, with a test for each `acceptance` item. If a card asks for
   a check "in CI", write it as a test that the existing `pnpm test` runs; never edit workflows.
3. Do not edit `plan/STATUS.json`, README's progress block or `docs/progress.svg`: the pipeline
   records the lane on main when it merges.
4. New dependencies: pin exact versions, check the licence is MIT, Apache-2.0, BSD or ISC, and
   use only releases at least 24 h old (`minimumReleaseAge`).
5. Run `pnpm typecheck && pnpm lint && pnpm test && pnpm build` and `npx prettier --check .`.
   All must pass.

### 3. Open the PR and hand it over

1. Check `git diff --name-only origin/main...HEAD` against the protected paths (see Rules). If any
   file matches, take that change out of the branch, or leave the lane unlabelled, report it and
   go to step 1.
2. Push, then run `gh pr create` with the title `B###: <lane title>` and the body from
   `plan/PR_TEMPLATE.md`. Add an acceptance-criterion-to-test table, "Deviations from the card"
   and "Risks / follow-ups" (including any CI wiring a human should add).
3. Hand over: `gh pr edit <PR> --add-label claude-automerge`, then confirm the label is there
   (`gh pr view <PR> --json labels`). If the label does not exist in the repo, stop and report
   that the pipeline setup is incomplete. From here on the pipeline owns the branch.
   **Never push to it again.**

### 4. Wait, without polling yourself

Run `node tools/ci/claude-pr-wait.mjs <PR>` as a background command; you are woken when it exits.
It checks every 3 minutes and re-dispatches the pipeline when the PR goes quiet. Do not wait with
`/loop` or repeated `gh` calls.

| Exit | Meaning                                                                                             | Next                                                   |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 0    | merged                                                                                              | step 1 (it fetches main)                               |
| 2    | handed to a human: `claude-needs-human`, `do-not-merge`, a change request, or the label was removed | note it, then step 1; its dependents are skipped       |
| 3    | closed without merging                                                                              | note it; skip the lane and its dependents for this run |
| 4    | timed out: 90 min with no activity, or 240 min in all                                               | see below                                              |
| 5    | the PR never got the `claude-automerge` label                                                       | add it once if your step 3 add failed; otherwise stop  |
| 1    | `gh` kept failing, or bad arguments                                                                 | stop                                                   |

On exit 4: if `gh variable get CLAUDE_AUTOMERGE` prints `off`, or the latest
`gh run list --workflow claude-pr.yml` runs are failing or not starting, stop and report. Otherwise
note the PR as stuck and go to step 1; its open PR keeps it and its dependents out of selection.

### 5. Report

When you stop, list each lane with its PR, its outcome, and for handoffs the reason the pipeline
gave (the PR's last comment). List partly built lanes you skipped.

## Rules that always apply

- Never edit a protected path: `contracts/`, `plan/`, `.github/`, `tools/plan/`, `tools/ci/`,
  `pnpm-workspace.yaml`, any `CLAUDE.md`, `.claude/`, `.mcp.json`, `.npmrc`, `.pnpmfile.*` (the
  full list is `protectedPaths` and `protectedNames` in `tools/ci/claude-pr.config.json`). The
  pipeline hands any PR that touches one to a human.
- Never merge, never approve, never post commit statuses, and never remove or re-add a pipeline
  label after a human or the pipeline changed it.
- Ask before anything outward-facing beyond the lane PR, such as extra PRs or repo settings.
