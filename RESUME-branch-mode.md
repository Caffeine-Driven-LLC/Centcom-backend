# Branch mode work: exact state (untracked file, never commit)
Checkout is on local/dev-integration (= the B109 stack + B110 + B111, never pushed); the dev stack runs from it (api :3000, relay :8088, worker).
Local branches (nothing pushed):
- plan/mirror-branch-mode: backend mirror of the client contract PR (#159 + the follow-up commit in ../Centcom-plan3 branch plan/branch-mode-contract-2: board.pin/remove use `target`). Stacked on origin/plan/mirror-collab (#113).
- lane/B110-session-mode (on the mirror): session mode (migration 20260102005300, API, relay mode port, welcome), command-post gate, lock/handoff owner checks, dev:branch-check, docs/branch-mode.md.
- lane/B111-board-notes (on B110): apps/relay/src/board/* + kind policy rows, docs/board-notes.md.
Verified live (on local/dev-integration): CENTCOM_CLIENT_DIR=../Centcom-plan3 pnpm dev:branch-check -> OK; dev:two-accounts and dev:two-clients -> OK.
Not done: lane PRs (cards B110/B111 must be on main first), a board purge hook, board Postgres table (card amended to a Redis doc), client changes (createSession mode option, frame_rate_exceeded mapping, pending-frame misattribution).
