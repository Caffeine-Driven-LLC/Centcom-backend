/**
 * The metric catalogue (B093): every metric a Centcom service may export, with its type, unit,
 * allowed labels and who emits it. Exported names carry the `centcom_` prefix
 * (`http_requests_total` is `centcom_http_requests_total`); code records the bare name through the
 * core `Metrics` interface (B005), and the OpenTelemetry bridge (metrics.ts) refuses anything the
 * catalogue does not list.
 *
 * - `platform` metrics are the observability catalogue proper (HTTP, relay, jobs and queues, the
 *   database pool, Redis latency, Stripe webhooks, outgoing webhooks, telemetry itself): the
 *   dashboards and SLOs are built on them.
 * - `module` metrics are the counters lanes already record (failures, drops, outcomes).
 * - `planned` names the lane that will first emit a metric that nothing records yet; it is
 *   catalogued now so dashboards and SLOs can name it. `onFailure` marks metrics recorded only when
 *   something fails (absent after healthy traffic).
 *
 * Labels come from small fixed sets only (route templates, methods, status classes, frame types,
 * close codes, queue names, outcomes): never a user, workspace, session, member or device id, an
 * e-mail or IP address, a raw URL or path, or any content (FORBIDDEN_LABEL).
 *
 * Owns: the names, units and label allow-lists. Must not: list a label that could hold an id.
 */

/** A service that exports metrics. */
export type ServiceName = 'api' | 'relay' | 'worker' | 'admin';

/** What kind of instrument. */
export type MetricType = 'counter' | 'histogram' | 'gauge';

/** One catalogued metric. */
export interface MetricDef {
  readonly type: MetricType;
  /** UCUM unit (`s`, `By`); empty when the name already says it or there is none. */
  readonly unit: string;
  /** Allowed label names; anything else is dropped. */
  readonly labels: readonly string[];
  /** Who emits it. */
  readonly services: readonly ServiceName[];
  readonly group: 'platform' | 'module';
  readonly help: string;
  /** Not emitted yet: the lane that will. */
  readonly planned?: string;
  /** Recorded only when something goes wrong (so absent after healthy traffic). */
  readonly onFailure?: true;
}

/** The prefix of every exported metric name. */
export const METRIC_PREFIX = 'centcom_';

/** A label value set may hold at most this many values; more is a cardinality violation. */
export const MAX_LABEL_VALUES = 100;

/** Label names that must never be used: ids, addresses, paths, content. */
export const FORBIDDEN_LABEL =
  /^(user|usr|workspace|wsp|session|ses|member|mem|device|dev|key|email|ip|client_ip|address|path|url|branch|body|content|token|ticket|ct|p|request|req|trace|span)(_?id)?$/i;

const ALL: readonly ServiceName[] = ['api', 'relay', 'worker'];
const API: readonly ServiceName[] = ['api'];
const RELAY: readonly ServiceName[] = ['relay'];
const WORKER: readonly ServiceName[] = ['worker'];
const API_WORKER: readonly ServiceName[] = ['api', 'worker'];

type Extra = Partial<Pick<MetricDef, 'unit' | 'planned' | 'group' | 'onFailure'>>;

/** A module counter. */
const counter = (
  help: string,
  labels: readonly string[] = [],
  services: readonly ServiceName[] = API,
  extra: Extra = {},
): MetricDef => ({ type: 'counter', unit: '', labels, services, group: 'module', help, ...extra });

/** A platform metric. */
const platform = (
  type: MetricType,
  help: string,
  labels: readonly string[],
  services: readonly ServiceName[],
  extra: Extra = {},
): MetricDef => ({
  type,
  unit: type === 'histogram' ? 's' : '',
  labels,
  services,
  group: 'platform',
  help,
  ...extra,
});

/** Every metric, by its name without the prefix. */
export const METRICS = {
  // HTTP (B005's request context plugin).
  http_requests_total: platform(
    'counter',
    'HTTP requests answered.',
    ['route', 'method', 'status_class'],
    API,
  ),
  http_request_duration_seconds: platform(
    'histogram',
    'HTTP request duration.',
    ['route', 'method'],
    API,
  ),

  // Relay (B037 on; card names).
  relay_connections: platform('gauge', 'Open WebSocket connections.', [], RELAY),
  relay_connections_total: platform('counter', 'WebSocket connections accepted.', [], RELAY),
  relay_frames_total: platform(
    'counter',
    'Frames by envelope type and direction.',
    ['t', 'direction'],
    RELAY,
  ),
  relay_close_total: platform('counter', 'Connections closed, by close code.', ['code'], RELAY),
  relay_handler_errors_total: platform('counter', 'Connection handlers that threw.', [], RELAY, {
    onFailure: true,
  }),
  relay_upgrades_refused_total: platform(
    'counter',
    'Upgrades answered with an HTTP error.',
    ['reason'],
    RELAY,
    { onFailure: true },
  ),
  relay_handshake_duration_seconds: platform(
    'histogram',
    'Handshake time, hello to welcome or refusal.',
    ['result'],
    RELAY,
    { planned: 'B038' },
  ),
  relay_fanout_latency_seconds: platform(
    'histogram',
    'Frame receipt to in-region delivery.',
    [],
    RELAY,
  ),
  relay_queue_items_total: counter(
    'Queue items entering a state (queued, approved, running, held, done, failed, canceled, rejected, dropped), by state.',
    ['state'],
    RELAY,
  ),
  relay_queue_rejections_total: counter(
    'Queue frames refused (or partly refused), by error code (queue_full, queue_item_gone, forbidden, conflict, invalid_frame, queue_not_allowed, service_unavailable).',
    ['code'],
    RELAY,
  ),
  relay_resume_total: platform(
    'counter',
    'Resume attempts by result (replayed, snapshot_required, failed, busy).',
    ['result'],
    RELAY,
  ),
  relay_resume_duration_seconds: platform(
    'histogram',
    'Resume time, request to resumed, by result (ok, failed).',
    ['result'],
    RELAY,
  ),
  relay_outbound_buffer_bytes: platform(
    'histogram',
    'Outbound buffer size per connection when sampled.',
    [],
    RELAY,
    { unit: 'By' },
  ),

  // Jobs and queues (worker; hooks.ts).
  job_duration_seconds: platform('histogram', 'Job execution time.', ['queue'], WORKER),
  job_failed_total: platform('counter', 'Job executions that failed.', ['queue'], WORKER, {
    onFailure: true,
  }),
  queue_depth: platform('gauge', 'Jobs waiting or delayed.', ['queue'], WORKER),
  queue_oldest_age_seconds: platform('gauge', 'Age of the oldest waiting job.', ['queue'], WORKER, {
    unit: 's',
  }),

  // Database pool (B007) and Redis (B009).
  db_pool_connections: platform('gauge', 'Pool connections by state.', ['state'], ALL),
  db_pool_max_connections: platform('gauge', 'Pool size limit.', [], ALL),
  db_pool_acquire_seconds: platform('histogram', 'Time to get a pool connection.', [], ALL),
  db_pool_timeouts_total: platform('counter', 'Pool connection waits that timed out.', [], ALL, {
    onFailure: true,
  }),
  db_connection_errors_total: platform(
    'counter',
    'Connections that could not be opened.',
    [],
    ALL,
    { onFailure: true },
  ),
  db_connections_lost_total: platform('counter', 'Connections lost while in use.', [], ALL, {
    onFailure: true,
  }),
  redis_ping_seconds: platform('histogram', 'Redis PING round trip, sampled.', [], ALL),

  // Billing and webhooks.
  session_expiry_failed_total: counter(
    'Session expiry sweep runs dead-lettered after their last attempt.',
    [],
    WORKER,
  ),
  session_host_outbox_failed_total: counter(
    'Host-change notifications (claim-host) the relay notifier refused and that were rescheduled.',
    [],
    API_WORKER,
  ),
  session_outbox_failed_total: counter(
    'Session transition notifications (relay or domain event) that failed and were rescheduled, by target (relay, event).',
    ['target'],
    API_WORKER,
  ),
  session_ticket_failures_total: counter(
    'Relay tickets not issued because signing failed or the ticket could not be recorded, by reason (signing, record).',
    ['reason'],
    API,
  ),
  session_transitions_total: counter(
    'Session lifecycle transitions, by the state reached (live, paused, ended, expired).',
    ['state'],
    API_WORKER,
  ),
  stripe_event_dead_letters_total: counter(
    'Stripe event jobs moved to stripe.event.dlq after their last attempt.',
    [],
    WORKER,
  ),
  stripe_event_enqueue_failures_total: counter(
    'Stored Stripe events that could not be queued (the sweep queues them).',
  ),
  stripe_events_stale_total: counter(
    'Sweeps that found an unprocessed Stripe event older than 10 minutes.',
    [],
    WORKER,
  ),
  stripe_events_total: counter(
    'Stripe events processed, by outcome (processed, ignored, failed, unknown_customer, unknown_plan).',
    ['outcome'],
    API_WORKER,
  ),
  stripe_webhooks_total: counter(
    'Stripe webhook deliveries, by outcome (stored, duplicate, ignored, rejected_*).',
    ['outcome'],
  ),
  stripe_webhook_lag_seconds: platform(
    'histogram',
    'Stripe event creation to processed.',
    ['type'],
    API_WORKER,
  ),
  webhook_deliveries_total: platform(
    'counter',
    'Outgoing webhook delivery attempts.',
    ['attempt', 'result'],
    WORKER,
    { planned: 'B081' },
  ),
  webhook_first_attempt_seconds: platform(
    'histogram',
    'Event to first delivery attempt answered.',
    ['result'],
    WORKER,
    { planned: 'B081' },
  ),

  // Telemetry itself.
  otel_export_failed_total: platform(
    'counter',
    'Telemetry exports that failed (data dropped).',
    ['signal'],
    ALL,
    { onFailure: true },
  ),
  otel_metric_violations_total: platform(
    'counter',
    'Metric records refused or rewritten by the catalogue.',
    ['kind'],
    ALL,
    { onFailure: true },
  ),

  // Modules.
  account_audit_failures_total: counter('Account audit writes that failed.'),
  account_deletions_blocked_total: counter(
    'Account deletions refused: the only owner of a workspace with other members.',
  ),
  account_deletions_requested_total: counter('Account deletions scheduled.'),
  account_deletions_restored_total: counter('Pending account deletions cancelled.'),
  account_export_dead_letters_total: counter('Account export jobs given up on.', ['job'], WORKER),
  account_exports_expired_total: counter('Account export files expired.', [], API_WORKER),
  account_exports_failed_total: counter('Account exports failed, by code.', ['code'], API_WORKER),
  account_exports_limited_total: counter('Account exports refused by the 24-hour limit.'),
  account_exports_requested_total: counter('Account exports requested.'),
  account_exports_written_total: counter('Account export files written.', [], API_WORKER),
  account_lifecycle_after_commit_failures_total: counter(
    'Account lifecycle steps after a commit that failed (revocation flags, queueing).',
    ['step'],
  ),
  account_purge_blocked_total: counter(
    'Account purges not run: the user owns a workspace with other members.',
    [],
    API_WORKER,
  ),
  account_purge_failed_total: counter('Account purges that failed.', [], WORKER),
  account_purges_total: counter('Account purge runs, by outcome.', ['outcome'], API_WORKER),
  admin_audit_failures_total: counter('Admin API calls whose audit write failed.'),
  admin_calls_total: counter('Admin API calls by outcome.', ['outcome']),
  admin_connections_refused_total: counter(
    'Admin listener connections from outside the allowlist.',
  ),
  api_key_last_used_failures_total: counter('API key last-used updates that failed.'),
  audit_emit_latency_ms: {
    type: 'histogram',
    unit: '',
    labels: ['mode'],
    services: API_WORKER,
    group: 'module',
    help: 'Audit write latency, milliseconds.',
  },
  audit_events_dropped_total: counter('Detached audit events dropped.', ['reason'], API_WORKER),
  audit_events_written_total: counter('Audit events written.', ['mode'], API_WORKER),
  audit_export_dead_letters_total: counter('Audit export jobs given up on.', ['job'], WORKER),
  audit_export_enqueue_failures_total: counter('Audit exports that could not be queued.'),
  audit_exports_requested_total: counter('Audit exports requested.', ['format']),
  audit_exports_total: counter('Audit exports finished, by outcome.', ['outcome'], API_WORKER),
  auth_revocation_unavailable_total: counter('Revocation checks Redis could not answer.', [
    'outcome',
  ]),
  billing_customers_created_total: counter('Stripe customers created for workspaces.'),
  billing_outbox_publish_failures_total: counter(
    'Billing outbox rows (or runs) that failed to publish, by type.',
    ['type'],
    API_WORKER,
  ),
  billing_outbox_published_total: counter(
    'Billing outbox rows published, by type.',
    ['type'],
    API_WORKER,
  ),
  billing_seat_changes_total: counter(
    'Seat changes and previews, by outcome (changed, unchanged, previewed, seats_in_use, single_seat_plan, inactive, stripe_failed).',
    ['outcome'],
  ),
  billing_seat_reconcile_runs_failed_total: counter(
    'Daily seat reconciliation runs that failed.',
    [],
    WORKER,
    { onFailure: true },
  ),
  billing_seat_reconciles_total: counter(
    'Workspaces whose seats were reconciled with Stripe, by outcome (in_sync, repaired, drift, failed).',
    ['outcome'],
    API_WORKER,
  ),
  billing_session_failures_total: counter(
    'Checkout and portal sessions Stripe did not create, by kind and reason (stripe_unavailable, stripe_refused).',
    ['kind', 'reason'],
  ),
  billing_sessions_created_total: counter('Checkout and portal sessions created, by kind.', [
    'kind',
  ]),
  billing_subscription_updates_total: counter(
    'Stripe subscription updates, by whether they were applied (false: a stale event).',
    ['applied'],
  ),
  coupon_redemptions_total: counter(
    'Coupon redeem attempts and promotion grants, by outcome (redeemed, replayed, refused, malformed, inactive, rate_limited, stripe_unavailable, busy).',
    ['outcome'],
  ),
  coupon_refusals_total: counter(
    'Coupon redemptions refused, by reason (never shown to the client).',
    ['reason'],
  ),
  devices_revoked_publish_failed_total: counter(
    'Device revocations not announced on devices:revoked after every retry.',
  ),
  devices_revoked_total: counter('Devices revoked.'),
  dunning_dead_letters_total: counter(
    'Dunning jobs (remind, wind-down, expire) moved to dunning.dead after their last attempt.',
    ['job'],
    WORKER,
    { onFailure: true },
  ),
  dunning_reminders_total: counter(
    'Dunning grace-day reminders, by day (0, 3, 6) and outcome (sent, stale, sent_before, not_due).',
    ['day', 'outcome'],
    API_WORKER,
  ),
  dunning_transitions_total: counter(
    'Dunning status changes, by the status left and the status reached.',
    ['from', 'to'],
    API_WORKER,
  ),
  dunning_wind_downs_total: counter(
    'Dunning wind-downs of live hosted sessions, by outcome (ended, skipped).',
    ['outcome'],
    API_WORKER,
  ),
  email_failed_total: counter('E-mails that failed for good.', ['template'], WORKER),
  email_idempotency_unrecorded_total: counter(
    'E-mail idempotency keys that could not be recorded.',
    [],
    API_WORKER,
  ),
  email_queued_total: counter('E-mails queued.', ['template'], API_WORKER),
  email_rate_limited_total: counter('E-mails refused by the rate limit.', ['template'], API_WORKER),
  email_rejected_total: counter('E-mails the provider rejected.', ['template'], WORKER),
  email_sent_total: counter('E-mails sent.', ['template'], WORKER),
  email_unrecorded_total: counter(
    'Sent e-mails whose delivery could not be recorded.',
    ['template'],
    WORKER,
  ),
  ent_cache_load_failures_total: counter(
    'Entitlement cache loads that failed.',
    [],
    ['api', 'relay'],
  ),
  ent_cache_loads_total: counter('Entitlement cache loads.', [], ['api', 'relay']),
  ent_cache_stale_served_total: counter('Stale entitlements served.', [], ['api', 'relay']),
  entitlements_invalidate_failures_total: counter('Entitlement invalidations that failed.'),
  entitlements_rev_changes_total: counter('Entitlement revisions, by cause.', ['cause']),
  entitlements_state_rejected_total: counter('Billing states refused.', ['code']),
  entitlements_unavailable_total: counter('Entitlement reads that failed.'),
  entitlements_usage_failures_total: counter('Usage reads for entitlements that failed.'),
  flags_publish_failures_total: counter('Flag change announcements that failed.'),
  flags_refresh_failures_total: counter('Flag cache refreshes that failed.'),
  flags_rule_errors_total: counter('Flag rules that could not be evaluated.'),
  history_append_failures_total: counter('History batches given up on after retries.', [], ALL),
  history_frames_refused_total: counter(
    'Frames the history store refused (encrypted kind with p, malformed).',
    ['reason'],
    ALL,
  ),
  history_frames_stored_total: counter('Frames written to the durable history.', [], ALL),
  history_purge_failures_total: counter('History purges that failed partway (resumable).'),
  history_purges_total: counter('Session histories purged on request.'),
  history_read_failures_total: counter('History reads answered 503 (a blob could not be read).'),
  idempotency_conflicts_total: counter('Idempotency key conflicts.', ['reason']),
  idempotency_invalid_records_total: counter('Unreadable idempotency records.'),
  idempotency_not_stored_total: counter('Responses not stored for replay.', ['reason']),
  idempotency_replays_total: counter('Responses replayed.'),
  idempotency_store_errors_total: counter('Idempotency store errors.'),
  idempotency_unprotected_total: counter('Requests served without idempotency protection.'),
  invite_expiry_failed_total: counter('Invite expiry runs that failed.', [], WORKER),
  invite_key_bundles_dropped_total: counter('Invite key bundles dropped.', [], WORKER),
  invite_mail_failures_total: counter('Invite e-mails that could not be queued.'),
  invites_accepted_total: counter('Invites accepted.'),
  invites_expired_total: counter('Invites expired.', [], WORKER),
  invoice_events_total: counter(
    'Stripe invoices handed to the invoice mirror, by outcome (written, unchanged, unsupported_currency, unknown_customer).',
    ['outcome'],
    API_WORKER,
  ),
  invoice_sync_failed_total: counter(
    'Invoice mirror syncs that failed, by reason (stripe_unavailable, stripe_error, error).',
    ['reason'],
    API,
    { onFailure: true },
  ),
  invoice_syncs_total: counter('Invoice mirror syncs that read Stripe and completed.'),
  invoices_unsupported_currency_total: counter(
    'Stripe invoices not mirrored because their currency is not USD or EUR, by source (event, sync).',
    ['source'],
    API_WORKER,
  ),
  log_dropped_total: counter('Log lines dropped.', [], ALL),
  magic_link_failures_total: counter('Sign-in link failures.', ['reason']),
  magic_link_limited_total: counter('Sign-in links refused by the rate limit.'),
  magic_link_logins_total: counter('Sign-ins by e-mail link.'),
  magic_link_mail_failures_total: counter('Sign-in link e-mails that could not be queued.'),
  magic_link_requests_total: counter('Sign-in links requested.'),
  membership_event_publish_failed_total: counter('Membership announcements that failed.', [
    'channel',
  ]),
  notification_channel_failures_total: counter('Notification channel failures.', ['channel']),
  notification_digest_failures_total: counter('Notification digests that failed.'),
  notification_digest_runs_failed_total: counter('Digest runs that failed.', [], WORKER),
  notification_digests_sent_total: counter('Notification digests sent.'),
  notification_dispatch_failed_total: counter('Notification dispatches that failed.', [], WORKER),
  notification_preferences_unavailable_total: counter('Preference reads that failed.'),
  notifications_deduped_total: counter('Notifications deduplicated.'),
  notifications_published_total: counter('Notifications published.', ['category']),
  notifications_written_total: counter('Notifications written.', ['category']),
  push_deliveries_deferred_total: counter('Push deliveries deferred.', [], WORKER),
  push_jobs_failed_total: counter('Push jobs that failed.', [], WORKER),
  push_sends_total: counter(
    'Push sends by provider and result.',
    ['provider', 'result'],
    API_WORKER,
  ),
  quota_crossings_total: counter('Usage quota thresholds crossed.', ['limit', 'pct']),
  quota_evaluations_rerun_total: counter(
    'Quota evaluations run again because the entitlements changed meanwhile.',
    [],
    API_WORKER,
  ),
  quota_evaluations_skipped_total: counter(
    'Quota evaluations skipped, by reason (no_entitlements, not_hosted, usage_missing).',
    ['reason'],
    API_WORKER,
  ),
  quota_signal_deliveries_total: counter(
    'Quota signal sends, by step (notice, notification, webhook).',
    ['step'],
    API_WORKER,
  ),
  quota_signal_delivery_failures_total: counter(
    'Quota signal sends that failed and will be retried, by step.',
    ['step'],
    API_WORKER,
  ),
  quota_signal_jobs_failed_total: counter(
    'Quota signal jobs dead-lettered after their last attempt, by job (evaluate, sweep).',
    ['job'],
    WORKER,
    { onFailure: true },
  ),
  quota_signals_rearmed_total: counter(
    'Quota signal levels re-armed (usage fell below them), by limit.',
    ['limit'],
    API_WORKER,
  ),
  quota_signals_total: counter(
    'Quota signals claimed, by limit and level.',
    ['limit', 'level'],
    API_WORKER,
  ),
  quota_state_cache_failures_total: counter(
    'Writes of the quota:state hash that failed.',
    [],
    API_WORKER,
  ),
  ratelimit_blocks_total: counter('Abuse blocks applied.', [], ALL),
  ratelimit_denied_total: counter('Requests refused by the rate limit.', ['bucket'], ALL),
  ratelimit_store_errors_total: counter('Rate limit store errors.', [], ALL),
  rbac_audit_failures_total: counter('RBAC refusal audits that failed.', [], ALL),
  rbac_denied_total: counter('RBAC refusals by action.', ['action'], ALL),
  redis_connection_errors_total: counter('Redis connection errors.', [], ALL),
  redis_memory_evictions_total: counter('Redis evictions noticed.', [], ALL),
  redis_pubsub_handler_errors_total: counter('Pub/sub handlers that threw.', [], ALL),
  redis_reconnects_total: counter('Redis reconnects.', [], ALL),
  redis_unavailable_total: counter('Redis calls refused while it was down.', [], ALL),
  relay_acks_rejected_total: counter('Acks refused for naming a seq beyond the head.', [], RELAY),
  relay_agent_spawns_refused_total: counter(
    'agent.spawn frames refused for the plan limit (max_parallel_agents), by reason.',
    ['reason'],
    RELAY,
  ),
  relay_agent_state_dropped_total: counter(
    'agent.* frames dropped before sequencing, by reason (rate, identical, exited).',
    ['reason'],
    RELAY,
  ),
  relay_agent_state_unknown_total: counter(
    'agent.state frames received with a state name the contract state map does not classify.',
    [],
    RELAY,
  ),
  relay_agent_store_failures_total: counter(
    'Agent registry saves that failed after the frame was sequenced.',
    [],
    RELAY,
    { onFailure: true },
  ),
  relay_agents_live: platform(
    'gauge',
    'Agents running, by mode (command_post, branch), on this node.',
    ['mode'],
    RELAY,
  ),
  relay_backpressure_closed_total: counter(
    'Slow consumers closed 4429, by reason (grace: not drained in time; node: the node guard).',
    ['reason'],
    RELAY,
  ),
  relay_backpressure_dropped_total: counter(
    'Droppable frames (presence, cursors) dropped for a connection over its soft mark.',
    [],
    RELAY,
  ),
  relay_backpressure_graces_total: counter(
    'Connections that went over the outbound limit (a grace started).',
    [],
    RELAY,
  ),
  relay_backpressure_recovered_total: counter(
    'Connections back under the soft mark within their grace.',
    [],
    RELAY,
  ),
  relay_backpressure_slow_downs_total: counter(
    'sys.slow_down frames sent for a full outbound buffer (at most one a second per connection).',
    [],
    RELAY,
  ),
  relay_cluster_control_closed_total: counter(
    'Local connections closed by member commands (supersede, removal, kick) from any node.',
    [],
    RELAY,
  ),
  relay_cluster_heartbeat_failed_total: counter(
    'Node heartbeat writes (relay:node:{id}) that failed.',
    [],
    RELAY,
  ),
  relay_cluster_lag_seconds: {
    type: 'histogram',
    unit: 's',
    labels: [],
    services: RELAY,
    group: 'module',
    help: 'Cross-node lag: a frame published by its node to its arrival on another.',
  },
  relay_cluster_publish_failed_total: counter(
    'Cluster publishes that failed, by channel (frames, eph, ctl).',
    ['channel'],
    RELAY,
  ),
  relay_cluster_published_total: counter(
    'Cluster messages published, by channel (frames, eph, ctl).',
    ['channel'],
    RELAY,
  ),
  relay_cluster_received_total: counter(
    'Cluster messages received, by channel and result (offered, delivered, applied, own, invalid).',
    ['channel', 'result'],
    RELAY,
  ),
  relay_cluster_reconcile_failed_total: counter(
    'Reconciles of a session against the head that failed (the store did not answer).',
    [],
    RELAY,
  ),
  relay_cluster_reconciled_total: counter(
    'Frames fetched from the hot buffer by a reconcile (lost or not yet subscribed).',
    [],
    RELAY,
  ),
  relay_cluster_subscriptions_total: counter(
    'Cluster channel subscriptions, by kind (session, member) and op (subscribed, unsubscribed, failed).',
    ['kind', 'op'],
    RELAY,
  ),
  relay_codec_errors_total: counter('Frames dropped because decoding threw.', [], RELAY),
  relay_control_frames_total: counter(
    'Client control frames (kick, mute, unmute, role, transfer_host, end, policy), by kind and outcome (accepted, denied, rejected, failed, duplicate).',
    ['kind', 'outcome'],
    RELAY,
  ),
  relay_control_mute_loads_failed_total: counter(
    "A session's mutes could not be read; its event and queue frames get service_unavailable until they can.",
    [],
    RELAY,
  ),
  relay_cursor_flood_closed_total: counter(
    'Members closed 4429 for a cursor flood (over 10x the rate for 10 s).',
    [],
    RELAY,
  ),
  relay_cursors_forwarded_total: counter(
    'Cursor frames written to local connections, by result (queued, dropped under backpressure, closed, error).',
    ['result'],
    RELAY,
  ),
  relay_cursors_total: counter(
    'presence.cursor frames received, by result (accepted, dropped_rate, dropped_size).',
    ['result'],
    RELAY,
  ),
  relay_dead_peers_total: counter(
    'Connections closed after RELAY_DEAD_MS without an inbound frame.',
    [],
    RELAY,
  ),
  relay_durable_append_failed_total: counter(
    'Durable appends of sequenced frames that failed (each attempt).',
    [],
    RELAY,
  ),
  relay_durable_append_given_up_total: counter(
    'Sequenced frames whose durable append was given up (retries spent or backlog full).',
    [],
    RELAY,
  ),
  relay_epoch_rotate_failed_total: counter(
    'control.rotate_request rotations that failed (the epoch store or sequencing was down).',
    [],
    RELAY,
  ),
  relay_epoch_rotation_due_total: counter(
    'Key epochs found due a scheduled rotation (7 days or 100 000 frames), once each.',
    [],
    RELAY,
  ),
  relay_epoch_rotations_total: counter(
    'control.rotate_key frames emitted, by reason (member_removed, scheduled, requested).',
    ['reason'],
    RELAY,
  ),
  relay_fanout_deliveries_total: counter(
    'Fan-out writes to connections, by result (queued, closed, dropped, error, no_room; held, replayed and overflow around a resume).',
    ['result'],
    RELAY,
  ),
  relay_fanout_gaps_total: counter(
    'Fan-out gaps, by result (filled from the hot buffer, or resync: the room was closed 1001).',
    ['result'],
    RELAY,
  ),
  relay_fanout_remote_failures_total: counter(
    'Frames the RemoteDispatcher (B045) failed to publish to other nodes.',
    [],
    RELAY,
  ),
  relay_frames_authorised_total: counter(
    'Member frames by authorisation outcome (allowed, forbidden, muted, not_a_member, unavailable, not_joined).',
    ['outcome'],
    RELAY,
  ),
  relay_frames_invalid_total: counter('Inbound frames refused by the codec.', ['code'], RELAY),
  relay_handshake_frames_dropped_total: counter(
    'Frames dropped while a hello was being checked.',
    [],
    RELAY,
  ),
  relay_handshakes_total: counter(
    'Handshakes by outcome (welcome or the refusal reason).',
    ['outcome'],
    RELAY,
  ),
  relay_hydrate_failed_total: counter(
    'Sessions the relay could not recover from the durable log (sequencing paused; alert).',
    [],
    RELAY,
  ),
  relay_hydrated_total: counter(
    'Sessions recovered from the durable log after the hot buffer lost them.',
    [],
    RELAY,
  ),
  relay_presence_delivered_total: counter(
    'Presence frames written to local connections, by result (queued, dropped under backpressure, closed, error).',
    ['result'],
    RELAY,
  ),
  relay_presence_fanouts_total: counter(
    'Coalesced presence frames sent out (one per member at most every 500 ms).',
    [],
    RELAY,
  ),
  relay_presence_offline_total: counter(
    'Members gone offline here after the 10 s grace.',
    [],
    RELAY,
  ),
  relay_presence_snapshots_total: counter('Presence snapshots sent after a welcome.', [], RELAY),
  relay_presence_store_failed_total: counter(
    'Presence store calls that failed (Redis; node-local memory took over).',
    [],
    RELAY,
  ),
  relay_presence_updates_total: counter(
    'presence.update frames, by result (accepted, coalesced, invalid, over_cap).',
    ['result'],
    RELAY,
  ),
  relay_privacy_violations_total: counter(
    'Fields or labels the privacy guard dropped, by where (frame: a clear field off the catalogue; size: a clear payload over 8 KiB; metric: a label).',
    ['where'],
    RELAY,
  ),
  relay_replay_frames_total: counter(
    'Frames replayed to resuming clients, by source (hot, durable).',
    ['source'],
    RELAY,
  ),
  relay_resume_stalled_total: counter(
    'Replays stopped because the client read nothing (closed 4429).',
    [],
    RELAY,
  ),
  relay_seq_assign_ms: {
    type: 'histogram',
    unit: '',
    labels: [],
    services: RELAY,
    group: 'module',
    help: 'Time to assign a seq (dedupe, counter and buffer append), milliseconds.',
  },
  relay_typing_cleared_total: counter(
    'Typing indicators cleared by the relay after 5 s without refresh.',
    [],
    RELAY,
  ),
  relay_sequenced_total: counter(
    'Sequenced frames by outcome (assigned, duplicate, rate_limited, unavailable, backlog).',
    ['outcome'],
    RELAY,
  ),
  relay_key_checks_unavailable_total: counter(
    'Grants or encrypted frames refused 503 because the epoch store or device lookup failed.',
    [],
    RELAY,
  ),
  relay_key_grants_total: counter(
    'key.grant frames, by result (routed, forbidden, invalid_frame).',
    ['result'],
    RELAY,
  ),
  relay_kid_refused_total: counter(
    'Encrypted frames refused for their ct.kid, by reason (invalid, future, stale).',
    ['reason'],
    RELAY,
  ),
  relay_membership_events_total: counter(
    'centcom:membership messages handled, by type.',
    ['type'],
    RELAY,
  ),
  relay_membership_subscribe_failures_total: counter(
    'Failed subscriptions to centcom:membership (retried with backoff).',
    [],
    RELAY,
  ),
  relay_room_joins_total: counter('Room joins by outcome (joined or full).', ['outcome'], RELAY),
  relay_superseded_total: counter(
    'Connections superseded by a newer one of the same member and device.',
    [],
    RELAY,
  ),
  releases_corrupt_total: counter('Release manifests that could not be read.'),
  releases_min_version_sync_failures_total: counter('Minimum client version syncs that failed.'),
  releases_published_total: counter('Releases published, by channel.', ['channel']),
  releases_refresh_failures_total: counter('Release cache refreshes that failed.'),
  retention_aborted_total: counter(
    'Retention policy runs stopped by the fraction brake, by reason.',
    ['policy', 'reason'],
    WORKER,
    { onFailure: true },
  ),
  retention_backlog: {
    type: 'gauge',
    unit: '',
    labels: ['policy'],
    services: WORKER,
    group: 'module',
    help: 'Items still due when a retention policy ran out of budget.',
  },
  retention_jobs_failed_total: counter('Retention jobs given up on.', ['job'], WORKER, {
    onFailure: true,
  }),
  retention_notice_failures_total: counter(
    'Retention shortening notices or emails that failed.',
    ['step'],
    WORKER,
    { onFailure: true },
  ),
  retention_policy_failures_total: counter(
    'Retention policy runs that failed.',
    ['policy'],
    WORKER,
    { onFailure: true },
  ),
  retention_purge_failures_total: counter(
    'Retention purges of one item that failed.',
    ['policy'],
    WORKER,
    { onFailure: true },
  ),
  retention_purged_total: counter('Items deleted by retention.', ['policy'], WORKER),
  retention_run_duration_seconds: {
    type: 'histogram',
    unit: 's',
    labels: ['policy'],
    services: WORKER,
    group: 'module',
    help: 'Retention policy run time.',
  },
  retention_throttled_total: counter(
    'Retention blob deletes the store throttled.',
    ['policy'],
    WORKER,
    { onFailure: true },
  ),
  retention_workspaces_skipped_total: counter(
    'Workspaces a retention policy skipped, by reason.',
    ['policy', 'reason'],
    WORKER,
    { onFailure: true },
  ),
  seat_gate_rejections_total: counter('Members refused for want of a seat.', ['reason']),
  snapshot_prune_failures_total: counter(
    'Snapshot prunes that stopped partway (the next prune finishes them).',
    [],
    API_WORKER,
    { onFailure: true },
  ),
  snapshot_pruned_total: counter(
    'Snapshots deleted, by reason (beyond_newest, expired_pending, retried, purged).',
    ['reason'],
    API_WORKER,
  ),
  snapshot_requests_total: counter(
    'Snapshot begins, commits and reads, by op (begin, commit, latest) and outcome (ok, refused, failed).',
    ['op', 'outcome'],
  ),
  snapshot_verify_failures_total: counter(
    'Snapshot commits answered 503 because the object could not be read.',
    [],
    API,
    { onFailure: true },
  ),
  status_feed_build_failures_total: counter('Status feed builds that failed.'),
  status_probes_total: counter('Status probes by component and result.', ['component', 'ok']),
  telemetry_accepted_total: counter('Product telemetry events accepted.'),
  telemetry_dropped_total: counter('Product telemetry events dropped.', ['reason']),
  telemetry_fields_dropped_total: counter('Product telemetry fields dropped.'),
  telemetry_partitions_dropped_total: counter(
    'Product telemetry partitions dropped.',
    [],
    API_WORKER,
  ),
  telemetry_retention_failed_total: counter('Telemetry retention runs that failed.', [], WORKER),
  telemetry_rollups_total: counter('Product telemetry rollups.', [], API_WORKER),
  trial_ending_emails_total: counter(
    'Trial-ending emails, by outcome (sent, not_trialing, not_configured, no_contact).',
    ['outcome'],
    API_WORKER,
  ),
  trials_recorded_total: counter('Trials recorded once Stripe confirmed them.', [], API_WORKER),
  usage_aggregate_failed_total: counter('Usage aggregation runs that failed.', [], WORKER),
  usage_daily_cap_refusals_total: counter('Usage events over the daily cap.'),
  usage_events_accepted_total: counter('Usage events accepted.'),
  usage_events_aggregated_total: counter('Usage events aggregated.', [], API_WORKER),
  usage_events_duplicate_total: counter('Duplicate usage events.'),
  usage_hint_failures_total: counter('Usage hints that failed.'),
  usage_relay_unavailable_total: counter('Usage reports while the relay was unreachable.'),
  webhook_attempts_total: counter('Outgoing webhook attempts, by result.', ['result'], API_WORKER),
  webhook_deliveries_created_total: counter(
    'Outgoing webhook deliveries created by fan-out.',
    [],
    API_WORKER,
  ),
  webhook_deliveries_dead_total: counter(
    'Outgoing webhook deliveries that failed every retry.',
    [],
    WORKER,
  ),
  webhook_endpoints_disabled_total: counter(
    'Webhook endpoints disabled after 3 days of failures.',
    [],
    API_WORKER,
  ),
  webhook_jobs_failed_total: counter('Webhook jobs that crashed.', ['queue'], WORKER),
  webhook_secret_unavailable_total: counter(
    'Deliveries paused for want of the signing key.',
    [],
    API_WORKER,
  ),
  workspace_announce_failures_total: counter('Workspace announcements that failed.'),
  workspace_purge_enqueue_failures_total: counter('Workspace purges that could not be queued.'),
  workspace_purge_failed_total: counter('Workspace purges that failed.', [], WORKER),
  workspace_purged_total: counter('Workspaces purged.', [], WORKER),
  workspace_settings_changed_total: counter('Workspace settings changes.'),
  workspace_settings_publish_failures_total: counter('Settings announcements that failed.'),
  workspaces_created_total: counter('Workspaces created.'),
  workspaces_deleted_total: counter('Workspaces deleted.'),
} as const satisfies Record<string, MetricDef>;

/** A catalogued metric name (without the prefix). */
export type MetricName = keyof typeof METRICS;

/** The definition of `name`, if catalogued. */
export function metricDef(name: string): MetricDef | undefined {
  return Object.hasOwn(METRICS, name) ? (METRICS as Record<string, MetricDef>)[name] : undefined;
}

/** The exported name of `name`. */
export const exportedName = (name: string): string => `${METRIC_PREFIX}${name}`;
