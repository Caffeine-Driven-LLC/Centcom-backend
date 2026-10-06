// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ (contract_version 1.2.0) via packages/contracts/scripts/generate.ts (lane B003).
// Regenerate with `pnpm contracts:gen`; `pnpm contracts:check` fails when this file is stale.

import type * as Api from './api.js';

// Types for contracts/schemas/*.json. Conditional rules (if/then/not) are enforced by the
// validators, not by these types.

/** Entitlements - CT-ENTITLEMENTS */
export type Entitlements = {
  workspace: string;
  rev: number;
  plan: "free" | "pro" | "team";
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  period?: {
    start?: string;
    end?: string;
  };
  limits: {
    relay_access: boolean;
    lan_multiplayer: true;
    max_seats: number | null;
    max_session_members: number | null;
    max_concurrent_sessions: number | null;
    max_parallel_agents: number | null;
    history_days: number | null;
    queue_items_month?: number | null;
    audit_log_days: number | null;
    webhooks_max: number | null;
    api_keys_max: number | null;
    hosted_minutes_month: number | null;
  };
  usage?: Record<string, number>;
  warnings?: Array<{
    limit: string;
    pct: number;
  }>;
  grace_until?: string | null;
};

/** WebSocket frame envelope - CT-WS-ENVELOPE */
export type Envelope = {
  v: 1;
  t: "sys.hello" | "sys.welcome" | "sys.ping" | "sys.pong" | "sys.error" | "sys.slow_down" | "sys.notice" | "sys.resume" | "sys.resumed" | "sys.bye" | "event" | "queue" | "control" | "presence" | "ack";
  id?: string;
  sid?: string;
  from?: string;
  ts?: string;
  seq?: number;
  ack?: number;
  ref?: string;
  k?: string;
  p?: Record<string, unknown>;
  ct?: {
    alg: "xchacha20poly1305";
    kid: string;
    n: string;
    c: string;
  };
  sig?: string;
};

/** LAN pairing frames - CT-LAN */
export type LanPair = {
  t: "lan.pair.1" | "lan.pair.2" | "lan.pair.3" | "lan.pair.4" | "lan.pair.err";
  cpace_msg?: string;
  fp?: string;
  device?: {
    id: string;
    x25519: string;
    ed25519: string;
    name: string;
  };
  confirm?: string;
  ok?: boolean;
  reconnect_token?: string;
  code?: "bad_code" | "locked_out" | "version" | "busy";
};

/** Notification - CT-NOTIF-PAYLOAD */
export type Notification = {
  id: string;
  created_at: string;
  read_at?: string | null;
  category: "trial_ending" | "approval_needed" | "queue_turn" | "mention" | "member_joined" | "member_left" | "agent_done" | "ci_failed" | "pr_merged" | "usage_warning" | "quota_reached" | "billing_issue" | "invite_received" | "update_available" | "security_alert";
  title_key: string;
  body_key: string;
  params?: Record<string, string | number | boolean>;
  action?: {
    type: "open_session" | "open_billing" | "open_invite" | "open_update" | "none";
    deeplink?: string;
  };
  priority: "low" | "normal" | "high";
};

/** Problem (RFC 9457) - CT-ERR */
export type Problem = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  request_id: string;
  retry_after_s?: number;
  errors?: Array<{
    pointer: string;
    code: string;
    detail?: string;
  }>;
};

/** Provider policy table - CT-PROVIDER */
export type ProviderPolicy = {
  checked_at: string;
  methods: Array<{
    id: string;
    provider: "anthropic" | "openai" | "other";
    status: "allowed" | "allowed_with_conditions" | "not_permitted" | "pending_confirmation";
    flag: string;
    engine?: string;
    source: string;
    conditions?: string[];
  }>;
};

/** Release manifest - CT-API-RELEASES */
export type ReleaseManifest = {
  channel: "stable" | "beta" | "nightly";
  version: string;
  released_at: string;
  min_supported: string;
  rollout_pct?: number;
  notes_url?: string;
  contract_version?: string;
  artifacts: Array<{
    platform: "linux" | "darwin" | "win32";
    arch: "x64" | "arm64";
    kind?: "binary" | "npm" | "archive";
    url: string;
    sha256: string;
    size: number;
    /** Ed25519 signature (base64url) over the sha256 digest bytes */
    sig: string;
    sig_kid?: string;
  }>;
};

/** Telemetry batch - CT-TELEMETRY */
export type Telemetry = {
  install_id: string;
  app?: {
    name?: string;
    version?: string;
    os?: string;
    arch?: string;
    contract?: string;
  };
  events: Array<{
    type: "app.start" | "app.exit" | "command.run" | "session.created" | "session.joined" | "agent.state_change" | "feature.used" | "error.shown" | "perf.startup" | "perf.frame" | "update.result";
    at: string;
    props?: Record<string, string | number | boolean>;
  }>;
};

/** Webhook delivery payload - CT-WEBHOOKS */
export type Webhook = {
  id: string;
  type: "workspace.member.joined" | "workspace.member.left" | "workspace.member.role_changed" | "workspace.invite.created" | "workspace.invite.accepted" | "workspace.invite.revoked" | "session.created" | "session.started" | "session.ended" | "session.member.joined" | "session.member.left" | "agent.completed" | "billing.subscription.updated" | "billing.invoice.paid" | "billing.invoice.payment_failed" | "usage.threshold" | "api_key.created" | "api_key.revoked" | "webhook.test";
  created_at: string;
  workspace: string;
  api_version: string;
  data: Record<string, unknown>;
};

// Event payloads: `<Kind>Payload` is the cleartext `p`, `<Kind>Secret` the decrypted `ct`.

export type MessageUserSecret = {
  text: string;
  agent_id?: string;
  queue_item?: string;
  attachments?: Record<string, unknown>[];
  reply_to?: string;
};

export type MessageAssistantDeltaSecret = {
  agent_id: string;
  message_id: string;
  index: number;
  delta: string;
};

export type MessageAssistantDoneSecret = {
  agent_id: string;
  message_id: string;
  input_tokens?: number;
  output_tokens?: number;
};

export type MessageSystemSecret = {
  level: "info" | "warn" | "error";
  text: string;
};

export type ToolRequestSecret = {
  agent_id: string;
  tool_id: string;
  name: string;
  input_summary: string;
  risk: "low" | "medium" | "high";
};

export type ApprovalRequestPayload = {
  approval_id: string;
  agent_id: string;
  risk: "low" | "medium" | "high";
  expires_at: string;
  approver: "host" | "owner" | "any_editor";
};

export type ApprovalRequestSecret = {
  summary: string;
  command?: string;
  cwd?: string;
};

export type ApprovalDecisionPayload = {
  approval_id: string;
  decision: "approve" | "deny";
  scope: "once" | "session" | "always";
};

export type ApprovalDecisionSecret = {
  reason?: string;
};

export type ToolResultSecret = {
  agent_id: string;
  tool_id: string;
  status: "ok" | "error" | "denied" | "canceled";
  summary: string;
};

export type AgentSpawnPayload = {
  agent_id: string;
  owner: string;
  mode: "command_post" | "branch";
  runs_on?: string;
  provider?: "anthropic" | "openai" | "other";
};

export type AgentSpawnSecret = {
  label?: string;
  branch?: string;
  worktree?: string;
  model?: string;
};

export type AgentStatePayload = {
  agent_id: string;
  state: "approved" | "asking-question" | "auth-required" | "awaiting-approval" | "away" | "background-task" | "celebrate" | "ci-fail" | "ci-pass" | "ci-running" | "compacting" | "context-full" | "cost-alert" | "crash" | "creating-file" | "deleting-file" | "denied" | "deploying" | "editing-file" | "empty" | "error" | "first-run" | "handoff" | "high-five" | "host-session" | "idle" | "listening" | "merge-conflict" | "message-queued" | "no-results" | "offline" | "online" | "pair-working" | "planning" | "pr-merged" | "pr-open" | "prompt-received" | "provider-auth-required" | "provider-cap-reached" | "provider-policy-blocked" | "quota-reached" | "rate-limited" | "reading-file" | "ready" | "reconnecting" | "running-command" | "saving" | "searching" | "session-expired" | "sleeping" | "streaming" | "sub-agent" | "success" | "teammate-joins" | "teammate-leaves" | "teammate-typing" | "tests-fail" | "tests-pass" | "thinking" | "thinking-hard" | "tool-running" | "update-available" | "warning" | "welcome-teammate";
  since: string;
};

export type AgentExitPayload = {
  agent_id: string;
  outcome: "ok" | "error" | "canceled";
  error_code?: string;
};

export type AgentExitSecret = {
  detail?: string;
};

export type BranchUpdateSecret = {
  agent_id: string;
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
};

export type FileLockPayload = {
  action: "acquire" | "release" | "deny" | "expire";
  path_hmac: string;
  agent_id: string;
  ttl_ms?: number;
};

export type FileLockSecret = {
  path?: string;
};

export type AgentHandoffPayload = {
  handoff: string;
  agent_id: string;
  to: string;
  op: "offer" | "accept" | "decline";
};

export type AgentHandoffSecret = {
  note?: string;
};

export type ConflictDetectedPayload = {
  agent_ids: string[];
  path_hmacs: string[];
};

export type ConflictDetectedSecret = {
  paths?: string[];
};

export type DiffShareSecret = {
  agent_id: string;
  files: Record<string, unknown>[];
  blob?: string;
};

export type ReactionPayload = {
  target: string;
  code: "thumbs" | "heart" | "party" | "laugh" | "eyes" | "check";
  op: "add" | "remove";
};

export type CommentAddSecret = {
  target: string;
  text: string;
};

export type KeyGrantPayload = {
  to_device: string;
  kids: string[];
};

export type KeyGrantSecret = {
  grants: Record<string, unknown>[];
};

export type QueueSubmitPayload = {
  item: string;
  size: number;
  kind: "message" | "command";
};

export type QueueSubmitSecret = {
  body: string;
  attachments?: Record<string, unknown>[];
};

export type QueueCancelPayload = {
  item: string;
};

export type QueueApprovePayload = {
  item: string;
};

export type QueueRejectPayload = {
  item: string;
  code: "not_now" | "off_topic" | "unsafe" | "duplicate" | "other";
};

export type QueueRejectSecret = {
  note?: string;
};

export type QueueReorderPayload = {
  order: string[];
};

export type QueueDropPayload = {
  item: string;
};

export type QueueClaimPayload = {
  item: string;
  agent_id: string;
};

export type QueueDonePayload = {
  item: string;
  outcome: "ok" | "error" | "canceled";
};

export type QueueStatePayload = {
  version: number;
  items: Record<string, unknown>[];
};

export type ControlKickPayload = {
  member: string;
  code: "abuse" | "inactive" | "request" | "other";
};

export type ControlMutePayload = {
  member: string;
  until?: string;
};

export type ControlUnmutePayload = {
  member: string;
};

export type ControlRolePayload = {
  member: string;
  role: "editor" | "viewer";
};

export type ControlTransferHostPayload = {
  to: string;
};

export type ControlEndPayload = {
  code: "done" | "abandoned" | "error";
};

export type ControlPolicyPayload = {
  auto_approve: "ask" | "trusted" | "everyone";
  share_history: boolean;
  queue_limit: number;
  locked?: boolean;
  auto_failover?: boolean;
  trusted?: string[];
  approvers?: string[];
  queue_paused?: boolean;
};

export type ControlMemberJoinedPayload = {
  member: string;
  name: string;
  slot: number;
  role: "host" | "editor" | "viewer";
  device: string;
};

export type ControlMemberLeftPayload = {
  member: string;
  code: "left" | "kicked" | "timeout" | "revoked";
};

export type ControlRosterPayload = {
  version: number;
  members: Record<string, unknown>[];
};

export type ControlHostChangedPayload = {
  host: string;
  code: "transfer" | "failover";
};

export type ControlSessionStatePayload = {
  state: "pending" | "live" | "paused" | "ended" | "expired";
};

export type ControlRotateRequestPayload = {
  reason: "scheduled" | "requested";
};

export type ControlRotateKeyPayload = {
  kid: string;
  reason: "member_removed" | "scheduled" | "requested";
};

export type PresenceUpdatePayload = {
  status: "online" | "away" | "busy";
  activity: "idle" | "typing" | "reviewing" | "running";
  agent_count?: number;
};

export type PresenceNudgePayload = {
  to: string;
};

export type PresenceCursorSecret = {
  path?: string;
  line?: number;
  col?: number;
  sel_end_line?: number;
  sel_end_col?: number;
};

/** Every event kind in the CT-WS-SESSION-EVENTS catalogue, in catalogue order. */
export type EventKind =
  | "message.user"
  | "message.assistant.delta"
  | "message.assistant.done"
  | "message.system"
  | "tool.request"
  | "approval.request"
  | "approval.decision"
  | "tool.result"
  | "agent.spawn"
  | "agent.state"
  | "agent.exit"
  | "branch.update"
  | "file.lock"
  | "agent.handoff"
  | "conflict.detected"
  | "diff.share"
  | "reaction"
  | "comment.add"
  | "key.grant"
  | "queue.submit"
  | "queue.cancel"
  | "queue.approve"
  | "queue.reject"
  | "queue.reorder"
  | "queue.drop"
  | "queue.claim"
  | "queue.done"
  | "queue.state"
  | "control.kick"
  | "control.mute"
  | "control.unmute"
  | "control.role"
  | "control.transfer_host"
  | "control.end"
  | "control.policy"
  | "control.member_joined"
  | "control.member_left"
  | "control.roster"
  | "control.host_changed"
  | "control.session_state"
  | "control.rotate_request"
  | "control.rotate_key"
  | "presence.update"
  | "presence.nudge"
  | "presence.cursor";

/** encrypted: `ct` only; hybrid: `p` and `ct`; clear: `p` only (CT-WS-SESSION-EVENTS). */
export type PayloadMode = 'encrypted' | 'hybrid' | 'clear';

/** Cleartext payload type per kind (kinds with a `p`). */
export interface EventPayloads {
  "approval.request": ApprovalRequestPayload;
  "approval.decision": ApprovalDecisionPayload;
  "agent.spawn": AgentSpawnPayload;
  "agent.state": AgentStatePayload;
  "agent.exit": AgentExitPayload;
  "file.lock": FileLockPayload;
  "agent.handoff": AgentHandoffPayload;
  "conflict.detected": ConflictDetectedPayload;
  "reaction": ReactionPayload;
  "key.grant": KeyGrantPayload;
  "queue.submit": QueueSubmitPayload;
  "queue.cancel": QueueCancelPayload;
  "queue.approve": QueueApprovePayload;
  "queue.reject": QueueRejectPayload;
  "queue.reorder": QueueReorderPayload;
  "queue.drop": QueueDropPayload;
  "queue.claim": QueueClaimPayload;
  "queue.done": QueueDonePayload;
  "queue.state": QueueStatePayload;
  "control.kick": ControlKickPayload;
  "control.mute": ControlMutePayload;
  "control.unmute": ControlUnmutePayload;
  "control.role": ControlRolePayload;
  "control.transfer_host": ControlTransferHostPayload;
  "control.end": ControlEndPayload;
  "control.policy": ControlPolicyPayload;
  "control.member_joined": ControlMemberJoinedPayload;
  "control.member_left": ControlMemberLeftPayload;
  "control.roster": ControlRosterPayload;
  "control.host_changed": ControlHostChangedPayload;
  "control.session_state": ControlSessionStatePayload;
  "control.rotate_request": ControlRotateRequestPayload;
  "control.rotate_key": ControlRotateKeyPayload;
  "presence.update": PresenceUpdatePayload;
  "presence.nudge": PresenceNudgePayload;
}

/** Decrypted secret payload type per kind (kinds with a secret schema). */
export interface EventSecrets {
  "message.user": MessageUserSecret;
  "message.assistant.delta": MessageAssistantDeltaSecret;
  "message.assistant.done": MessageAssistantDoneSecret;
  "message.system": MessageSystemSecret;
  "tool.request": ToolRequestSecret;
  "approval.request": ApprovalRequestSecret;
  "approval.decision": ApprovalDecisionSecret;
  "tool.result": ToolResultSecret;
  "agent.spawn": AgentSpawnSecret;
  "agent.exit": AgentExitSecret;
  "branch.update": BranchUpdateSecret;
  "file.lock": FileLockSecret;
  "agent.handoff": AgentHandoffSecret;
  "conflict.detected": ConflictDetectedSecret;
  "diff.share": DiffShareSecret;
  "comment.add": CommentAddSecret;
  "key.grant": KeyGrantSecret;
  "queue.submit": QueueSubmitSecret;
  "queue.reject": QueueRejectSecret;
  "presence.cursor": PresenceCursorSecret;
}

/** One catalogue entry: frame type, payload mode and the cleartext fields the relay may read. */
export interface EventCatalogueEntry {
  readonly t: string;
  readonly mode: PayloadMode;
  readonly clearFields: readonly string[];
  readonly secret: boolean;
}

/** The event catalogue, generated from contracts/schemas/events.schema.json. */
export const EVENT_CATALOGUE = {
  "message.user": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "message.assistant.delta": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "message.assistant.done": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "message.system": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "tool.request": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "approval.request": { t: "event", mode: "hybrid", clearFields: ["approval_id","agent_id","risk","expires_at","approver"], secret: true },
  "approval.decision": { t: "event", mode: "hybrid", clearFields: ["approval_id","decision","scope"], secret: true },
  "tool.result": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "agent.spawn": { t: "event", mode: "hybrid", clearFields: ["agent_id","owner","mode","runs_on","provider"], secret: true },
  "agent.state": { t: "event", mode: "clear", clearFields: ["agent_id","state","since"], secret: false },
  "agent.exit": { t: "event", mode: "hybrid", clearFields: ["agent_id","outcome","error_code"], secret: true },
  "branch.update": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "file.lock": { t: "event", mode: "hybrid", clearFields: ["action","path_hmac","agent_id","ttl_ms"], secret: true },
  "agent.handoff": { t: "event", mode: "hybrid", clearFields: ["handoff","agent_id","to","op"], secret: true },
  "conflict.detected": { t: "event", mode: "hybrid", clearFields: ["agent_ids","path_hmacs"], secret: true },
  "diff.share": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "reaction": { t: "event", mode: "clear", clearFields: ["target","code","op"], secret: false },
  "comment.add": { t: "event", mode: "encrypted", clearFields: [], secret: true },
  "key.grant": { t: "event", mode: "hybrid", clearFields: ["to_device","kids"], secret: true },
  "queue.submit": { t: "queue", mode: "hybrid", clearFields: ["item","size","kind"], secret: true },
  "queue.cancel": { t: "queue", mode: "clear", clearFields: ["item"], secret: false },
  "queue.approve": { t: "queue", mode: "clear", clearFields: ["item"], secret: false },
  "queue.reject": { t: "queue", mode: "clear", clearFields: ["item","code"], secret: true },
  "queue.reorder": { t: "queue", mode: "clear", clearFields: ["order"], secret: false },
  "queue.drop": { t: "queue", mode: "clear", clearFields: ["item"], secret: false },
  "queue.claim": { t: "queue", mode: "clear", clearFields: ["item","agent_id"], secret: false },
  "queue.done": { t: "queue", mode: "clear", clearFields: ["item","outcome"], secret: false },
  "queue.state": { t: "queue", mode: "clear", clearFields: ["version","items"], secret: false },
  "control.kick": { t: "control", mode: "clear", clearFields: ["member","code"], secret: false },
  "control.mute": { t: "control", mode: "clear", clearFields: ["member","until"], secret: false },
  "control.unmute": { t: "control", mode: "clear", clearFields: ["member"], secret: false },
  "control.role": { t: "control", mode: "clear", clearFields: ["member","role"], secret: false },
  "control.transfer_host": { t: "control", mode: "clear", clearFields: ["to"], secret: false },
  "control.end": { t: "control", mode: "clear", clearFields: ["code"], secret: false },
  "control.policy": { t: "control", mode: "clear", clearFields: ["auto_approve","share_history","queue_limit","locked","auto_failover","trusted","approvers","queue_paused"], secret: false },
  "control.member_joined": { t: "control", mode: "clear", clearFields: ["member","name","slot","role","device"], secret: false },
  "control.member_left": { t: "control", mode: "clear", clearFields: ["member","code"], secret: false },
  "control.roster": { t: "control", mode: "clear", clearFields: ["version","members"], secret: false },
  "control.host_changed": { t: "control", mode: "clear", clearFields: ["host","code"], secret: false },
  "control.session_state": { t: "control", mode: "clear", clearFields: ["state"], secret: false },
  "control.rotate_request": { t: "control", mode: "clear", clearFields: ["reason"], secret: false },
  "control.rotate_key": { t: "control", mode: "clear", clearFields: ["kid","reason"], secret: false },
  "presence.update": { t: "presence", mode: "clear", clearFields: ["status","activity","agent_count"], secret: false },
  "presence.nudge": { t: "presence", mode: "clear", clearFields: ["to"], secret: false },
  "presence.cursor": { t: "presence", mode: "encrypted", clearFields: [], secret: true },
} as const satisfies Record<EventKind, EventCatalogueEntry>;

/** Every event kind, in catalogue order. */
export const EVENT_KINDS: readonly EventKind[] = ["message.user","message.assistant.delta","message.assistant.done","message.system","tool.request","approval.request","approval.decision","tool.result","agent.spawn","agent.state","agent.exit","branch.update","file.lock","agent.handoff","conflict.detected","diff.share","reaction","comment.add","key.grant","queue.submit","queue.cancel","queue.approve","queue.reject","queue.reorder","queue.drop","queue.claim","queue.done","queue.state","control.kick","control.mute","control.unmute","control.role","control.transfer_host","control.end","control.policy","control.member_joined","control.member_left","control.roster","control.host_changed","control.session_state","control.rotate_request","control.rotate_key","presence.update","presence.nudge","presence.cursor"];

/**
 * Value type per schema key. Keys: a schema file stem (`events` validates a whole frame),
 * `event/<kind>` (cleartext payload), `event-secret/<kind>` (secret payload), `api/<Name>`
 * (an OpenAPI component).
 */
export interface SchemaTypes {
  "entitlements": Entitlements;
  "envelope": Envelope;
  "events": Envelope;
  "lan-pair": LanPair;
  "notification": Notification;
  "problem": Problem;
  "provider-policy": ProviderPolicy;
  "release-manifest": ReleaseManifest;
  "telemetry": Telemetry;
  "webhook": Webhook;
  "event/approval.request": ApprovalRequestPayload;
  "event/approval.decision": ApprovalDecisionPayload;
  "event/agent.spawn": AgentSpawnPayload;
  "event/agent.state": AgentStatePayload;
  "event/agent.exit": AgentExitPayload;
  "event/file.lock": FileLockPayload;
  "event/agent.handoff": AgentHandoffPayload;
  "event/conflict.detected": ConflictDetectedPayload;
  "event/reaction": ReactionPayload;
  "event/key.grant": KeyGrantPayload;
  "event/queue.submit": QueueSubmitPayload;
  "event/queue.cancel": QueueCancelPayload;
  "event/queue.approve": QueueApprovePayload;
  "event/queue.reject": QueueRejectPayload;
  "event/queue.reorder": QueueReorderPayload;
  "event/queue.drop": QueueDropPayload;
  "event/queue.claim": QueueClaimPayload;
  "event/queue.done": QueueDonePayload;
  "event/queue.state": QueueStatePayload;
  "event/control.kick": ControlKickPayload;
  "event/control.mute": ControlMutePayload;
  "event/control.unmute": ControlUnmutePayload;
  "event/control.role": ControlRolePayload;
  "event/control.transfer_host": ControlTransferHostPayload;
  "event/control.end": ControlEndPayload;
  "event/control.policy": ControlPolicyPayload;
  "event/control.member_joined": ControlMemberJoinedPayload;
  "event/control.member_left": ControlMemberLeftPayload;
  "event/control.roster": ControlRosterPayload;
  "event/control.host_changed": ControlHostChangedPayload;
  "event/control.session_state": ControlSessionStatePayload;
  "event/control.rotate_request": ControlRotateRequestPayload;
  "event/control.rotate_key": ControlRotateKeyPayload;
  "event/presence.update": PresenceUpdatePayload;
  "event/presence.nudge": PresenceNudgePayload;
  "event-secret/message.user": MessageUserSecret;
  "event-secret/message.assistant.delta": MessageAssistantDeltaSecret;
  "event-secret/message.assistant.done": MessageAssistantDoneSecret;
  "event-secret/message.system": MessageSystemSecret;
  "event-secret/tool.request": ToolRequestSecret;
  "event-secret/approval.request": ApprovalRequestSecret;
  "event-secret/approval.decision": ApprovalDecisionSecret;
  "event-secret/tool.result": ToolResultSecret;
  "event-secret/agent.spawn": AgentSpawnSecret;
  "event-secret/agent.exit": AgentExitSecret;
  "event-secret/branch.update": BranchUpdateSecret;
  "event-secret/file.lock": FileLockSecret;
  "event-secret/agent.handoff": AgentHandoffSecret;
  "event-secret/conflict.detected": ConflictDetectedSecret;
  "event-secret/diff.share": DiffShareSecret;
  "event-secret/comment.add": CommentAddSecret;
  "event-secret/key.grant": KeyGrantSecret;
  "event-secret/queue.submit": QueueSubmitSecret;
  "event-secret/queue.reject": QueueRejectSecret;
  "event-secret/presence.cursor": PresenceCursorSecret;
  "api/UserId": Api.UserId;
  "api/WorkspaceId": Api.WorkspaceId;
  "api/DeviceId": Api.DeviceId;
  "api/MemberId": Api.MemberId;
  "api/InviteId": Api.InviteId;
  "api/ApiKeyId": Api.ApiKeyId;
  "api/WebhookId": Api.WebhookId;
  "api/DeliveryId": Api.DeliveryId;
  "api/NotificationId": Api.NotificationId;
  "api/SnapshotId": Api.SnapshotId;
  "api/ProjectId": Api.ProjectId;
  "api/SessionId": Api.SessionId;
  "api/SubscriptionId": Api.SubscriptionId;
  "api/AuditEventId": Api.AuditEventId;
  "api/RequestId": Api.RequestId;
  "api/AgentId": Api.AgentId;
  "api/ExportId": Api.ExportId;
  "api/PushSubscriptionId": Api.PushSubscriptionId;
  "api/Money": Api.Money;
  "api/Role": Api.Role;
  "api/SessionRole": Api.SessionRole;
  "api/Scope": Api.Scope;
  "api/ProblemError": Api.ProblemError;
  "api/Problem": Api.Problem;
  "api/Page": Api.Page;
  "api/User": Api.User;
  "api/Me": Api.Me;
  "api/MeUpdate": Api.MeUpdate;
  "api/AccountDeletion": Api.AccountDeletion;
  "api/DataExport": Api.DataExport;
  "api/Device": Api.Device;
  "api/DeviceKeys": Api.DeviceKeys;
  "api/ApiKey": Api.ApiKey;
  "api/ApiKeyCreate": Api.ApiKeyCreate;
  "api/ApiKeyCreated": Api.ApiKeyCreated;
  "api/WorkspaceSettings": Api.WorkspaceSettings;
  "api/WorkspaceSettingsUpdate": Api.WorkspaceSettingsUpdate;
  "api/Workspace": Api.Workspace;
  "api/WorkspaceCreate": Api.WorkspaceCreate;
  "api/WorkspaceUpdate": Api.WorkspaceUpdate;
  "api/Member": Api.Member;
  "api/MemberUpdate": Api.MemberUpdate;
  "api/OwnershipTransfer": Api.OwnershipTransfer;
  "api/Invite": Api.Invite;
  "api/InviteCreate": Api.InviteCreate;
  "api/InviteCreated": Api.InviteCreated;
  "api/InvitePreview": Api.InvitePreview;
  "api/InviteAcceptance": Api.InviteAcceptance;
  "api/KeyBundle": Api.KeyBundle;
  "api/Project": Api.Project;
  "api/ProjectCreate": Api.ProjectCreate;
  "api/ProjectUpdate": Api.ProjectUpdate;
  "api/SessionPolicy": Api.SessionPolicy;
  "api/SessionMember": Api.SessionMember;
  "api/Session": Api.Session;
  "api/SessionCreate": Api.SessionCreate;
  "api/SessionCreated": Api.SessionCreated;
  "api/SessionUpdate": Api.SessionUpdate;
  "api/JoinTokenRequest": Api.JoinTokenRequest;
  "api/JoinToken": Api.JoinToken;
  "api/CtEnvelope": Api.CtEnvelope;
  "api/HistoryFrame": Api.HistoryFrame;
  "api/HistoryPage": Api.HistoryPage;
  "api/SnapshotDescriptor": Api.SnapshotDescriptor;
  "api/SnapshotBegin": Api.SnapshotBegin;
  "api/SnapshotUpload": Api.SnapshotUpload;
  "api/SnapshotCommit": Api.SnapshotCommit;
  "api/ShareLinkCreate": Api.ShareLinkCreate;
  "api/ShareLink": Api.ShareLink;
  "api/ShareLinkJoin": Api.ShareLinkJoin;
  "api/EntLimits": Api.EntLimits;
  "api/Entitlements": Api.Entitlements;
  "api/Plan": Api.Plan;
  "api/Subscription": Api.Subscription;
  "api/CheckoutRequest": Api.CheckoutRequest;
  "api/UrlResponse": Api.UrlResponse;
  "api/PortalRequest": Api.PortalRequest;
  "api/SeatChange": Api.SeatChange;
  "api/SeatChangeResult": Api.SeatChangeResult;
  "api/Invoice": Api.Invoice;
  "api/CouponRedeem": Api.CouponRedeem;
  "api/UsageSummary": Api.UsageSummary;
  "api/UsageEvent": Api.UsageEvent;
  "api/UsageBatch": Api.UsageBatch;
  "api/UsageBatchResult": Api.UsageBatchResult;
  "api/AuditEvent": Api.AuditEvent;
  "api/AuditExportCreate": Api.AuditExportCreate;
  "api/AuditExport": Api.AuditExport;
  "api/Notification": Api.Notification;
  "api/ReadAllResult": Api.ReadAllResult;
  "api/NotificationPreferences": Api.NotificationPreferences;
  "api/PushSubscription": Api.PushSubscription;
  "api/PushSubscriptionCreate": Api.PushSubscriptionCreate;
  "api/WebhookEventType": Api.WebhookEventType;
  "api/Webhook": Api.Webhook;
  "api/WebhookCreate": Api.WebhookCreate;
  "api/WebhookCreated": Api.WebhookCreated;
  "api/WebhookUpdate": Api.WebhookUpdate;
  "api/WebhookRotated": Api.WebhookRotated;
  "api/WebhookDelivery": Api.WebhookDelivery;
  "api/ReleaseManifest": Api.ReleaseManifest;
  "api/Flags": Api.Flags;
  "api/StatusFeed": Api.StatusFeed;
  "api/HealthStatus": Api.HealthStatus;
  "api/Jwks": Api.Jwks;
  "api/TelemetryEvent": Api.TelemetryEvent;
  "api/TelemetryBatch": Api.TelemetryBatch;
  "api/DeviceCodeRequest": Api.DeviceCodeRequest;
  "api/DeviceCodeResponse": Api.DeviceCodeResponse;
  "api/TokenRequest": Api.TokenRequest;
  "api/TokenResponse": Api.TokenResponse;
  "api/RevokeRequest": Api.RevokeRequest;
  "api/WorkspacePage": Api.WorkspacePage;
  "api/MemberPage": Api.MemberPage;
  "api/InvitePage": Api.InvitePage;
  "api/ProjectPage": Api.ProjectPage;
  "api/SessionPage": Api.SessionPage;
  "api/SessionMemberPage": Api.SessionMemberPage;
  "api/DevicePage": Api.DevicePage;
  "api/ApiKeyPage": Api.ApiKeyPage;
  "api/InvoicePage": Api.InvoicePage;
  "api/AuditEventPage": Api.AuditEventPage;
  "api/NotificationPage": Api.NotificationPage;
  "api/WebhookPage": Api.WebhookPage;
  "api/WebhookDeliveryPage": Api.WebhookDeliveryPage;
}

/** Every key accepted by `validate()`. */
export type SchemaKey = keyof SchemaTypes;
