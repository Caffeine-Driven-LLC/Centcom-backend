// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ (contract_version 1.2.0) via packages/contracts/scripts/generate.ts (lane B003).
// Regenerate with `pnpm contracts:gen`; `pnpm contracts:check` fails when this file is stale.

// CT-STATE-MAP: product state name -> mascot animation, from contracts/state-map.json.

/** Every product state and the animation it maps to. */
export const STATE_MAP = {
  "idle": "idle_breathe",
  "ready": "ready_prompt",
  "listening": "voice_listening",
  "prompt-received": "prompt_received",
  "thinking": "thinking",
  "thinking-hard": "thinking_hard",
  "planning": "plan_mode",
  "searching": "searching",
  "reading-file": "reading_file",
  "editing-file": "editing_file",
  "creating-file": "creating_file",
  "deleting-file": "deleting_file",
  "running-command": "running_command",
  "tool-running": "tool_running",
  "streaming": "streaming_response",
  "awaiting-approval": "permission_prompt",
  "approved": "tool_approve",
  "denied": "tool_deny",
  "asking-question": "asking_question",
  "compacting": "compacting",
  "context-full": "context_full",
  "background-task": "background_task",
  "sub-agent": "sub_agent_spawn",
  "saving": "session_saved",
  "success": "thumbs_up",
  "celebrate": "celebrate",
  "error": "error",
  "crash": "crash",
  "warning": "worried",
  "offline": "offline",
  "reconnecting": "reconnecting",
  "online": "back_online",
  "auth-required": "auth_needed",
  "session-expired": "session_expired",
  "rate-limited": "rate_limited",
  "quota-reached": "quota_reached",
  "cost-alert": "cost_alert",
  "update-available": "update_available",
  "first-run": "first_run_welcome",
  "empty": "empty_state",
  "no-results": "no_results",
  "sleeping": "sleeping",
  "away": "status_away",
  "tests-pass": "tests_passing",
  "tests-fail": "tests_failing",
  "ci-running": "ci_running",
  "ci-pass": "ci_passed",
  "ci-fail": "ci_failed",
  "pr-open": "pr_open",
  "pr-merged": "pr_merged",
  "deploying": "deploy",
  "merge-conflict": "merge_conflict",
  "host-session": "master_session",
  "teammate-joins": "join_session",
  "teammate-leaves": "leave_session",
  "teammate-typing": "typing_indicator",
  "message-queued": "queue_position",
  "handoff": "handoff",
  "pair-working": "pair_programming",
  "high-five": "high_five",
  "welcome-teammate": "welcome",
  "provider-auth-required": "auth_needed",
  "provider-cap-reached": "quota_reached",
  "provider-policy-blocked": "permission_denied",
} as const;

/** A product state name. Receivers tolerate unknown names (CT-STATE-MAP rule 1). */
export type ProductState = keyof typeof STATE_MAP;

/** Every product state name, in contract order. */
export const PRODUCT_STATES: readonly ProductState[] = ["idle","ready","listening","prompt-received","thinking","thinking-hard","planning","searching","reading-file","editing-file","creating-file","deleting-file","running-command","tool-running","streaming","awaiting-approval","approved","denied","asking-question","compacting","context-full","background-task","sub-agent","saving","success","celebrate","error","crash","warning","offline","reconnecting","online","auth-required","session-expired","rate-limited","quota-reached","cost-alert","update-available","first-run","empty","no-results","sleeping","away","tests-pass","tests-fail","ci-running","ci-pass","ci-fail","pr-open","pr-merged","deploying","merge-conflict","host-session","teammate-joins","teammate-leaves","teammate-typing","message-queued","handoff","pair-working","high-five","welcome-teammate","provider-auth-required","provider-cap-reached","provider-policy-blocked"];
