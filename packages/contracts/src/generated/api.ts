// GENERATED FILE - DO NOT EDIT.
// Source: contracts/ (contract_version 1.2.0) via packages/contracts/scripts/generate.ts (lane B003).
// Regenerate with `pnpm contracts:gen`; `pnpm contracts:check` fails when this file is stale.

// TypeScript types for every components.schemas entry of contracts/openapi.yaml.

/** Prefixed ULID of a user. */
export type UserId = string;

/** Prefixed ULID of a workspace. */
export type WorkspaceId = string;

/** Prefixed ULID of a device. */
export type DeviceId = string;

/** Prefixed ULID of a membership. */
export type MemberId = string;

/** Prefixed ULID of a invite. */
export type InviteId = string;

/** Prefixed ULID of a API key. */
export type ApiKeyId = string;

/** Prefixed ULID of a webhook endpoint. */
export type WebhookId = string;

/** Prefixed ULID of a webhook delivery. */
export type DeliveryId = string;

/** Prefixed ULID of a notification. */
export type NotificationId = string;

/** Prefixed ULID of a snapshot. */
export type SnapshotId = string;

/** Prefixed ULID of a project. */
export type ProjectId = string;

/** Prefixed ULID of a session. */
export type SessionId = string;

/** Prefixed ULID of a subscription. */
export type SubscriptionId = string;

/** Prefixed ULID of a audit event. */
export type AuditEventId = string;

/** Prefixed ULID of a request. */
export type RequestId = string;

/** Prefixed ULID of a agent. */
export type AgentId = string;

/** Prefixed ULID of a export job (prefix not defined in CT-IDS; see x-gaps). */
export type ExportId = string;

/** Prefixed ULID of a push subscription (prefix not defined in CT-IDS; see x-gaps). */
export type PushSubscriptionId = string;

export type Money = {
  /** Minor units (cents) */
  amount: number;
  currency: "USD" | "EUR";
};

/**
 * Workspace role. Consumers must tolerate unknown values.
 *
 * Extensible: readers must tolerate unknown values (validate with mode "tolerant"); this type lists the known values.
 */
export type Role = "owner" | "admin" | "member" | "billing" | "guest";

export type SessionRole = "host" | "editor" | "viewer";

export type Scope = "profile" | "workspaces:read" | "workspaces:write" | "sessions:read" | "sessions:write" | "sessions:host" | "billing:read" | "billing:write" | "usage:write" | "webhooks:write" | "audit:read";

export type ProblemError = {
  /** JSON Pointer into the request */
  pointer: string;
  code: string;
  detail?: string;
};

/** RFC 9457 problem details (CT-ERR). Defined inline; no contracts/schemas/problem.schema.json existed when written. */
export type Problem = {
  type: string;
  title: string;
  status: number;
  /** Stable code from errors.json */
  code: string;
  detail?: string;
  instance?: string;
  request_id: RequestId;
  retry_after_s?: number;
  errors?: ProblemError[];
};

/** Generic CT-PAGE wrapper; typed variants are <Name>Page. */
export type Page = {
  data: unknown[];
  next_cursor: string | null;
  has_more: boolean;
};

export type User = {
  id: UserId;
  email: string;
  display_name: string;
  /** BCP 47 */
  locale: string;
  /** Avatar slot identifier */
  avatar?: string | null;
  telemetry: boolean;
  created_at: string;
  deletion_scheduled_for?: string | null;
};

/** Current user, plan summary, active workspace and entitlement revision (the access-token `ent` claim). */
export type Me = {
  user: User;
  plan: "free" | "pro" | "team";
  active_workspace: WorkspaceId | null;
  ent: number;
};

export type MeUpdate = {
  display_name?: string;
  locale?: string;
  avatar?: string | null;
  telemetry?: boolean;
};

export type AccountDeletion = {
  status: "pending_deletion";
  scheduled_for: string;
  grace_days?: number;
};

export type DataExport = {
  id: ExportId;
  status: "pending" | "ready" | "failed" | "expired";
  created_at: string;
  expires_at?: string | null;
  /** Signed, short-lived */
  download_url?: string | null;
  size_bytes?: number | null;
};

export type Device = {
  id: DeviceId;
  name: string;
  platform: "linux" | "macos" | "windows" | "web" | "other";
  created_at: string;
  last_seen_at?: string | null;
  revoked_at?: string | null;
  /** ABCD-EFGH-IJKL (CT-CRYPTO) */
  key_fingerprint: string;
  current?: boolean;
};

export type DeviceKeys = {
  device: DeviceId;
  /** 32-byte raw key, base64url without padding */
  x25519: string;
  /** 32-byte raw key, base64url without padding */
  ed25519: string;
  fingerprint: string;
  revoked?: boolean;
};

export type ApiKey = {
  id: ApiKeyId;
  workspace: WorkspaceId;
  name: string;
  /** First 8 chars of the key, display only */
  prefix: string;
  scopes: Scope[];
  created_by?: UserId;
  created_at: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
};

export type ApiKeyCreate = {
  workspace: WorkspaceId;
  name: string;
  scopes: Scope[];
  expires_at?: string;
};

export type ApiKeyCreated = ApiKey & {
  /** Returned once only */
  secret: string;
};

/** Retention override must not exceed the plan history_days. */
export type WorkspaceSettings = {
  /** Default auto-approve level (matches control.policy.auto_approve) */
  auto_approve: "ask" | "trusted" | "everyone";
  share_history: boolean;
  history_retention_days?: number | null;
};

export type WorkspaceSettingsUpdate = {
  auto_approve?: "ask" | "trusted" | "everyone";
  share_history?: boolean;
  history_retention_days?: number | null;
};

export type Workspace = {
  id: WorkspaceId;
  name: string;
  slug: string;
  role?: Role;
  owner?: UserId;
  plan?: "free" | "pro" | "team";
  member_count?: number;
  created_at: string;
  settings?: WorkspaceSettings;
};

export type WorkspaceCreate = {
  name: string;
  slug?: string;
};

export type WorkspaceUpdate = {
  name?: string;
  settings?: WorkspaceSettingsUpdate;
};

export type Member = {
  id: MemberId;
  user: UserId;
  display_name: string;
  /** Omitted for guests / limited views */
  email?: string;
  role: Role;
  joined_at: string;
};

export type MemberUpdate = {
  /** owner is only assignable via transfer-ownership */
  role: "admin" | "member" | "billing" | "guest";
};

export type OwnershipTransfer = {
  to_member: MemberId;
};

export type Invite = {
  id: InviteId;
  workspace: WorkspaceId;
  email?: string | null;
  role: "admin" | "member" | "billing" | "guest";
  status: "pending" | "accepted" | "revoked" | "expired";
  share_history?: boolean;
  created_by?: UserId;
  created_at: string;
  expires_at: string;
};

export type InviteCreate = {
  /** Omit to create a link-only invite */
  email?: string;
  role?: "admin" | "member" | "billing" | "guest";
  share_history?: boolean;
};

export type InviteCreated = Invite & {
  /** 160-bit URL-safe single-purpose token */
  token: string;
  /** https://centcom.dev/i/<token> */
  url: string;
};

export type InvitePreview = {
  workspace_name: string;
  inviter_name: string;
  role: "admin" | "member" | "billing" | "guest";
  expires_at: string;
  has_key_bundle?: boolean;
};

export type InviteAcceptance = {
  workspace: Workspace;
  member: Member;
};

export type KeyBundle = {
  /** crypto_box_seal of the epoch keys to the one-time invite public key (CT-CRYPTO section 4), base64url */
  bundle: string;
};

export type Project = {
  id: ProjectId;
  workspace: WorkspaceId;
  name: string;
  /** Named repo reference (e.g. owner/name); never a local path */
  repo?: string | null;
  created_at: string;
};

export type ProjectCreate = {
  name: string;
  repo?: string;
};

export type ProjectUpdate = {
  name?: string;
  repo?: string | null;
};

export type SessionPolicy = {
  auto_approve?: "ask" | "trusted" | "everyone";
  share_history?: boolean;
  queue_limit?: number;
  locked?: boolean;
  auto_failover?: boolean;
};

export type SessionMember = {
  id: MemberId;
  user?: UserId;
  display_name?: string;
  device?: DeviceId;
  role: SessionRole;
  slot: number;
  join_order: number;
  device_keys: DeviceKeys;
  joined_at?: string;
};

export type Session = {
  id: SessionId;
  workspace: WorkspaceId;
  name: string;
  state: "pending" | "live" | "paused" | "ended" | "expired";
  host: MemberId;
  policy: SessionPolicy;
  /** Relay region, e.g. eu, us */
  region: string;
  created_at: string;
  ended_at?: string | null;
  member_count?: number;
};

export type SessionCreate = {
  workspace: WorkspaceId;
  name: string;
  project?: ProjectId;
  policy?: SessionPolicy;
  region_preference?: string;
};

export type SessionCreated = Session & {
  /** Region the client should connect to */
  region_hint: string;
  relay_url?: string;
  host_member: SessionMember;
};

export type SessionUpdate = {
  name?: string;
  policy?: SessionPolicy;
};

export type JoinTokenRequest = {
  /** Optional capabilities requested (e.g. resume) */
  caps?: string[];
};

export type JoinToken = {
  /** Relay ticket JWT, aud centcom-relay, 60 s, single use */
  ticket: string;
  expires_in: number;
  relay_url: string;
  region?: string;
  member: MemberId;
  role: SessionRole;
  caps?: string[];
};

export type CtEnvelope = {
  alg: "xchacha20poly1305";
  kid: string;
  /** base64url without padding */
  n: string;
  /** base64url without padding */
  c: string;
};

/** Stored ciphertext frame (CT-WS-ENVELOPE shape). Never plaintext. */
export type HistoryFrame = {
  v: number;
  t: string;
  /** msg_ ULID */
  id: string;
  sid: SessionId;
  from?: MemberId;
  ts: string;
  seq: number;
  k?: string;
  p?: Record<string, unknown>;
  ct?: CtEnvelope;
  /** base64url without padding */
  sig?: string;
};

export type HistoryPage = {
  data: HistoryFrame[];
  next_cursor: string | null;
  has_more: boolean;
  head_seq?: number;
  earliest_seq?: number;
};

export type SnapshotDescriptor = {
  snp: SnapshotId;
  seq: number;
  size: number;
  /** Hash in <alg>:<hex> form */
  sha256: string;
  kid: string;
  created_at?: string;
  /** Pre-signed GET */
  download_url?: string;
  expires_in?: number;
};

export type SnapshotBegin = {
  /** Expected size in bytes, <= 32 MiB */
  size?: number;
  kid?: string;
};

export type SnapshotUpload = {
  snp: SnapshotId;
  /** Pre-signed PUT */
  upload_url: string;
  expires_in: number;
};

export type SnapshotCommit = {
  seq: number;
  /** Hash in <alg>:<hex> form */
  sha256: string;
  size: number;
  kid: string;
};

export type ShareLinkCreate = {
  expires_in_s?: number;
};

export type ShareLink = {
  token: string;
  url: string;
  session: SessionId;
  created_at: string;
  expires_at: string;
  revoked_at?: string | null;
};

export type ShareLinkJoin = {
  display_name: string;
};

/** null = unlimited; unknown keys must be tolerated. */
export type EntLimits = {
  relay_access: boolean;
  lan_multiplayer: boolean;
  max_seats: number | null;
  max_session_members: number;
  max_concurrent_sessions: number;
  max_parallel_agents: number;
  history_days: number;
  queue_items_month: number | null;
  audit_log_days: number;
  webhooks_max: number;
  api_keys_max: number;
  hosted_minutes_month: number | null;
};

/** CT-ENTITLEMENTS. Defined inline; no contracts/schemas/entitlements.schema.json existed when written. */
export type Entitlements = {
  workspace: WorkspaceId;
  rev: number;
  plan: "free" | "pro" | "team";
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  period?: {
    start: string;
    end: string;
  };
  limits: EntLimits;
  usage?: {
    queue_items_month?: number;
    seats?: number;
    hosted_minutes_month?: number;
  };
  warnings?: Array<{
    limit: string;
    pct: number;
  }>;
  grace_until?: string | null;
};

export type Plan = {
  id: "free" | "pro" | "team";
  name: string;
  prices: Array<{
    interval: "month" | "year";
    unit?: "seat" | "workspace";
    price: Money;
  }>;
  limits: EntLimits;
};

export type Subscription = {
  id: SubscriptionId;
  workspace: WorkspaceId;
  plan: "free" | "pro" | "team";
  status: "active" | "trialing" | "past_due" | "canceled";
  seats: number;
  interval?: "month" | "year";
  currency?: "USD" | "EUR";
  current_period_start?: string;
  current_period_end: string;
  cancel_at_period_end?: boolean;
  trial_end?: string | null;
  grace_until?: string | null;
};

export type CheckoutRequest = {
  plan: "pro" | "team";
  seats?: number;
  interval: "month" | "year";
  currency?: "USD" | "EUR";
  success_url?: string;
  cancel_url?: string;
};

export type UrlResponse = {
  url: string;
  expires_at?: string;
};

export type PortalRequest = {
  return_url?: string;
};

export type SeatChange = {
  seats: number;
};

export type SeatChangeResult = {
  seats: number;
  preview: boolean;
  proration?: {
    amount: Money;
    effective_at?: string;
  } | null;
};

export type Invoice = {
  /** Opaque invoice id (no CT-IDS prefix defined) */
  id: string;
  number?: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  amount_due: Money;
  amount_paid: Money;
  period_start?: string;
  period_end?: string;
  created_at: string;
  hosted_invoice_url?: string;
  pdf_url?: string;
};

export type CouponRedeem = {
  code: string;
};

export type UsageSummary = {
  workspace: WorkspaceId;
  period: {
    start: string;
    end: string;
  };
  items: Array<{
    metric: "agent_minutes" | "tokens" | "queue_items" | "relay_bytes" | "seats";
    used: number;
    limit: number | null;
    pct?: number | null;
  }>;
};

export type UsageEvent = {
  /** Client-generated ULID with prefix use_ (CT-IDS) */
  id: string;
  type: "agent_minutes" | "tokens_in" | "tokens_out" | "queue_items" | "relay_bytes";
  qty: number;
  at: string;
  session_id?: SessionId;
  agent_id?: AgentId;
};

export type UsageBatch = {
  events: UsageEvent[];
};

export type UsageBatchResult = {
  accepted: number;
  duplicates: number;
  rejected?: Array<{
    id: string;
    code: string;
  }>;
};

export type AuditEvent = {
  id: AuditEventId;
  workspace: WorkspaceId;
  at: string;
  actor: {
    type: "user" | "api_key" | "system";
    id?: string;
  };
  /** e.g. member.removed */
  action: string;
  target?: {
    type?: string;
    id?: string;
  };
  result?: "allowed" | "denied";
  metadata?: Record<string, unknown>;
};

export type AuditExportCreate = {
  format: "csv" | "json";
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
};

export type AuditExport = {
  id: ExportId;
  status: "pending" | "ready" | "failed" | "expired";
  format: "csv" | "json";
  created_at: string;
  expires_at?: string | null;
  download_url?: string | null;
};

/** CT-NOTIF-PAYLOAD. Defined inline; no contracts/schemas/notification.schema.json existed when written. */
export type Notification = {
  id: NotificationId;
  created_at: string;
  read_at: string | null;
  category: "approval_needed" | "queue_turn" | "mention" | "member_joined" | "member_left" | "agent_done" | "ci_failed" | "pr_merged" | "usage_warning" | "quota_reached" | "billing_issue" | "invite_received" | "update_available" | "security_alert";
  title_key: string;
  body_key: string;
  /** Ids and enums only */
  params?: Record<string, unknown>;
  action?: {
    type: string;
    deeplink?: string;
  };
  priority: "low" | "normal" | "high";
};

export type ReadAllResult = {
  updated: number;
};

export type NotificationPreferences = {
  /** Per category channel switches; os is client-local */
  channels: {
    approval_needed?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    queue_turn?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    mention?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    member_joined?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    member_left?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    agent_done?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    ci_failed?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    pr_merged?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    usage_warning?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    quota_reached?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    billing_issue?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    invite_received?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    update_available?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
    security_alert?: {
      inbox?: boolean;
      push?: boolean;
      email?: boolean;
      os?: boolean;
    };
  };
  quiet_hours: {
    enabled: boolean;
    start?: string;
    end?: string;
    /** IANA tz */
    timezone?: string;
    allow_approval_needed?: boolean;
  };
};

export type PushSubscription = {
  id: PushSubscriptionId;
  kind: "web_push" | "apns" | "fcm";
  device?: DeviceId;
  created_at: string;
};

export type PushSubscriptionCreate = {
  kind: "web_push" | "apns" | "fcm";
  /** APNs/FCM token, or web-push endpoint URL */
  token: string;
  keys?: {
    /** base64url without padding */
    p256dh: string;
    /** base64url without padding */
    auth: string;
  };
  device?: DeviceId;
};

/**
 * Consumers must tolerate unknown values.
 *
 * Extensible: readers must tolerate unknown values (validate with mode "tolerant"); this type lists the known values.
 */
export type WebhookEventType = "workspace.member.joined" | "workspace.member.left" | "workspace.member.role_changed" | "workspace.invite.created" | "workspace.invite.accepted" | "workspace.invite.revoked" | "session.created" | "session.started" | "session.ended" | "session.member.joined" | "session.member.left" | "agent.completed" | "billing.subscription.updated" | "billing.invoice.paid" | "billing.invoice.payment_failed" | "usage.threshold" | "api_key.created" | "api_key.revoked";

/** Defined inline; no contracts/schemas/webhook.schema.json existed when written. */
export type Webhook = {
  id: WebhookId;
  workspace: WorkspaceId;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  status: "active" | "failing" | "disabled";
  created_at: string;
  secret_rotated_at?: string | null;
  secret_overlap_until?: string | null;
};

export type WebhookCreate = {
  /** HTTPS only (localhost allowed in test mode) */
  url: string;
  events: WebhookEventType[];
};

export type WebhookCreated = Webhook & {
  /** Signing secret, shown once */
  secret: string;
};

export type WebhookUpdate = {
  url?: string;
  events?: WebhookEventType[];
  enabled?: boolean;
  rotate_secret?: boolean;
};

export type WebhookRotated = Webhook & {
  /** Present only when rotate_secret was true; old secret stays valid 24 h */
  secret?: string;
};

export type WebhookDelivery = {
  id: DeliveryId;
  webhook: WebhookId;
  event_type: WebhookEventType;
  attempt: number;
  status: "pending" | "succeeded" | "failed";
  response_status?: number | null;
  duration_ms?: number | null;
  created_at: string;
  next_attempt_at?: string | null;
};

/** Defined inline; no contracts/schemas/release-manifest.schema.json existed when written. */
export type ReleaseManifest = {
  channel: "stable" | "beta" | "nightly";
  version: string;
  released_at: string;
  min_supported_version?: string;
  notes_url?: string;
  artifacts: Array<{
    platform: "linux" | "macos" | "windows";
    arch: "x64" | "arm64";
    kind?: string;
    url: string;
    /** Hash in <alg>:<hex> form */
    sha256: string;
    size?: number;
    /** Ed25519 signature (64 bytes), base64url */
    signature: string;
  }>;
};

export type Flags = {
  flags: Record<string, boolean | string | number | Record<string, unknown> | null>;
  rev: number;
  ttl_s: number;
};

export type StatusFeed = {
  status: "operational" | "degraded" | "partial_outage" | "major_outage";
  updated_at: string;
  components: Array<{
    id: string;
    name: string;
    status: "operational" | "degraded" | "partial_outage" | "major_outage";
  }>;
  incidents: Array<{
    id: string;
    title: string;
    status: string;
    started_at: string;
    updates?: Array<{
      at: string;
      text: string;
    }>;
  }>;
  min_client_version: string;
  contract_version: string;
  deprecations?: Array<{
    what: string;
    sunset?: string;
  }>;
};

export type HealthStatus = {
  status: "ok" | "degraded";
  checks?: Record<string, string>;
};

export type Jwks = {
  keys: Array<{
    kty: "OKP";
    crv: "Ed25519";
    kid: string;
    use?: "sig";
    alg?: "EdDSA";
    /** 32-byte raw key, base64url without padding */
    x: string;
  }>;
};

export type TelemetryEvent = {
  type: "app.start" | "app.exit" | "command.run" | "session.created" | "session.joined" | "agent.state_change" | "feature.used" | "error.shown" | "perf.startup" | "perf.frame" | "update.result";
  at: string;
  /** Allowed props only: enums, counts, durations; never content, paths, names */
  props?: Record<string, unknown>;
};

/** <= 64 KiB. Defined inline; no contracts/schemas/telemetry.schema.json existed when written. */
export type TelemetryBatch = {
  install_id: string;
  app_version?: string;
  platform?: string;
  events: TelemetryEvent[];
};

export type DeviceCodeRequest = {
  client_id: "centcom-cli" | "centcom-web" | "centcom-tui";
  /** Space-separated scopes */
  scope?: string;
  device_name: string;
  device_pubkeys: {
    /** 32-byte raw key, base64url without padding */
    x25519: string;
    /** 32-byte raw key, base64url without padding */
    ed25519: string;
  };
};

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

/** Sent as application/json or application/x-www-form-urlencoded. Web clients must send X-Centcom-Client: web. */
export type TokenRequest = {
  grant_type: "urn:ietf:params:oauth:grant-type:device_code";
  device_code: string;
  client_id: string;
} | {
  grant_type: "authorization_code";
  code: string;
  code_verifier: string;
  redirect_uri: string;
  client_id: string;
} | {
  grant_type: "refresh_token";
  refresh_token: string;
  client_id: string;
  scope?: string;
};

export type TokenResponse = {
  /** EdDSA JWT, 15 min */
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  /** Opaque rotating token */
  refresh_token: string;
  scope: string;
  device?: DeviceId;
  user?: UserId;
};

/** Provide token or device. */
export type RevokeRequest = {
  /** Refresh token to revoke */
  token?: string;
  token_type_hint?: "refresh_token";
  device?: DeviceId;
};

export type WorkspacePage = {
  data: Workspace[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type MemberPage = {
  data: Member[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type InvitePage = {
  data: Invite[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type ProjectPage = {
  data: Project[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type SessionPage = {
  data: Session[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type SessionMemberPage = {
  data: SessionMember[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type DevicePage = {
  data: Device[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type ApiKeyPage = {
  data: ApiKey[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type InvoicePage = {
  data: Invoice[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type AuditEventPage = {
  data: AuditEvent[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type NotificationPage = {
  data: Notification[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type WebhookPage = {
  data: Webhook[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};

export type WebhookDeliveryPage = {
  data: WebhookDelivery[];
  /** Opaque cursor, null on the last page */
  next_cursor: string | null;
  has_more: boolean;
};
