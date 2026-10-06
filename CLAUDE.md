# Claude Code in Centcom-backend

Start with `plan/START_HERE.md`, `plan/GUIDELINES.md` and the lane card you are building. Lane
cards are `plan/lanes/backend/B###.json`. Contracts in `contracts/` win over cards (GUIDELINES
§2.2).

## Lane loop

Lanes are built one at a time. After opening a PR, the session waits until the Claude PR pipeline
(`.github/workflows/claude-pr.yml`, described in `docs/ci.md`) reviews and merges it. Then it
starts the next lane, so each lane builds on merged work. The pipeline reviews, fixes and merges.
This session never merges, and never approves its own PR.

### 1. Pick the next lane

A lane is eligible when all of these hold:

- it is not merged yet: no `B###: ` subject in `git log origin/main --format=%s`;
- every lane in its `depends_on` is merged (same test);
- no open PR exists for it (`gh pr list --state open --json title`). This also skips a lane handed
  to a human, and everything that depends on it, until a human sorts it out;
- none of its `deliverables` sit under `contracts/`, `plan/`, `.github/`, `tools/plan/`,
  `tools/ci/` or `pnpm-workspace.yaml`. The pipeline always hands those to a human, so leave
  them for a session a human is watching.

Take eligible lanes in the order of `plan/STATUS.json` → `next`, then by lowest ID. If none is
eligible, stop and report.

### 2. Build it

1. `git checkout main && git pull --ff-only`, then branch `lane/B###-short-slug`.
2. Build only the card's `deliverables`, with a test for each `acceptance` item.
3. In `plan/STATUS.json`, mark the lane `{"pct": 1, "note": "merged in #<PR>"}` once you know
   the PR number. Then run `python3 tools/plan/progress.py` (on Windows, set `PYTHONUTF8=1`).
   `plan/STATUS.json` is the only file under `plan/` that a lane changes.
4. New dependencies: pin exact versions, check the licence is MIT, Apache-2.0, BSD or ISC, and
   use only releases at least 24 h old (`minimumReleaseAge`).
5. Run `pnpm typecheck && pnpm lint && pnpm test && pnpm build` and `npx prettier --check .`.
   All must pass.

### 3. Open the PR and hand it over

1. Push, then run `gh pr create` with the title `B###: <lane title>` and the body from
   `plan/PR_TEMPLATE.md`. Add an acceptance-criterion-to-test table, "Deviations from the card"
   and "Risks / follow-ups". Do not add the label yet.
2. Commit the `plan/STATUS.json` and progress update with the PR number, and push.
3. Hand over: `gh pr edit <PR> --add-label claude-automerge`. From here on the pipeline owns the
   branch. **Never push to it again.** The pipeline pushes fixes and merges of `main` to it.

### 4. Wait, without polling yourself

Run `node tools/ci/claude-pr-wait.mjs <PR>` as a background command; you are woken when it exits.
It checks every 3 minutes. Do not wait with `/loop` or repeated `gh` calls.

| Exit | Meaning                                       | Next                                             |
| ---- | --------------------------------------------- | ------------------------------------------------ |
| 0    | merged                                        | step 1 (it pulls `main`)                         |
| 2    | handed to a human (`claude-needs-human`, etc) | note it, then step 1; its dependents are skipped |
| 3    | closed without merging                        | note it, then step 1                             |
| 4    | timed out: no activity for 60 min             | stop: the pipeline is likely broken or paused    |
| 5    | not opted in: the label is missing            | add the label, then wait again (once); else stop |
| 1    | `gh` kept failing or bad arguments            | stop                                             |

Never remove `claude-needs-human`, push to a handed-off PR, or merge anything yourself. A human
sorts those out.

### 5. Report

When you stop, list each lane with its PR, its outcome, and for handoffs the reason the pipeline
gave (the PR's last comment).

## Rules that always apply

- Never edit `contracts/`, or `plan/` other than `plan/STATUS.json` (GUIDELINES §9).
- Ask before anything outward-facing beyond the lane PR, such as extra or scratch PRs or repo
  settings.
