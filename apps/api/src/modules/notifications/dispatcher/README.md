# Notification dispatcher (B063)

Turns domain events into CT-NOTIF-PAYLOAD notifications and hands them to the inbox, push and
e-mail. The shared names (categories, the event type, queues, job options) are in
`@centcom/core`, the SQL in `@centcom/db` (`createNotificationStore`), and the BullMQ jobs in
`@centcom/worker` (`notify-dispatch`, `notify-digest`).

```ts
const dispatcher = new NotificationDispatcher({
  store: createNotificationStore(db),
  preferences, // B066: get(userId) → NotificationPreferences | null
  push, // B064: enqueue(userId, payload)
  email, // over B032's e-mail service: enqueue(userId, 'notification' | 'notification_digest', …)
  queue: createNotifyDispatchQueue({ connection, prefix }), // @centcom/worker
  logger,
  metrics,
});
// A producing lane:
await dispatcher.publish({
  category: 'approval_needed',
  recipients: { session: sessionId, members: [hostMemberId] },
  params: { agent: agentId, session: sessionId, risk: 'medium' },
  priority: 'high',
  dedupeKey: `${approvalId}`,
  action: { type: 'open_session', deeplink: notificationDeeplink(sessionId, 'approval') },
});
// The worker process:
startNotifyDispatchWorker({
  connection,
  prefix,
  deadLetter,
  process: (job) => dispatcher.process(job),
});
startNotifyDigestWorker({
  connection,
  prefix,
  run: () => runDigest({ store, email, logger, metrics }),
});
await scheduleNotifyDigest(createNotifyDigestQueue({ connection, prefix }));
```

## Rules

- **Publish:** the event is checked first. A bad category, recipients, priority, dedupe key,
  action or param throws a `NotificationEventError` (pointers and codes, never values); nothing is
  queued. A queue that cannot be reached is a 503 `service_unavailable` with `retry_after_s: 1`:
  the producing lane decides (its outbox), the event is never dropped silently.
- **Params** hold only the keys each category's allow-list names (`PARAM_RULES`, from
  CT-NOTIF-PAYLOAD), each an id of its prefix, an enum value, a short lower-case token (at most 64
  characters, no spaces) or an integer in range. Never free text, never anything from `ct`.
- **Recipients** are resolved at dispatch: `{users}` (active users; only those still in the
  session the params name), `{workspace, roles}` (active members of the live workspace with those
  roles), `{session, members}` (members who have not left). At most 1 000 per event.
- **Channels:** approval_needed → inbox, push, os; billing_issue → inbox, email; the rest → inbox;
  overridden per channel by the user's switches. security_alert and billing_issue always reach
  the inbox, and quiet hours never touch them. Quiet hours (the user's window, in their time zone)
  drop push and os, except a high-priority approval_needed the user allowed. Preferences that
  cannot be read: the defaults, logged and counted.
- **Writes:** one notification per user and event (a dispatch run again writes and sends nothing
  more), and one per (user, dedupe key) within 10 minutes (a sliding window, under an advisory
  lock).
- **Sends**, for a row just written: push when the channels hold push; e-mail at once for urgent
  items (high priority, security_alert, billing_issue), else the item waits for the hourly
  digest. A failing channel is logged and counted (`notification_channel_failures_total{channel}`)
  and never stops the inbox row or the other channels.
- **Digest:** hourly, one e-mail per user with up to 50 waiting items, oldest first, marked sent in
  the same transaction as the send (the rest wait for the next run); a second run in the hour
  sends nothing; one user's failure leaves their items and does not stop the others.
- **Jobs:** `notify.dispatch` retries 5 times (exponential backoff from 5 s, jitter 0.5), then the
  event goes to `notify.dispatch.dlq`.
- **Logs** carry the category, ids and counts; never param values.

## Tests

`apps/api/test/notifications/dispatcher/`: `dispatcher.routing.test.ts` (the matrix, quiet hours,
default routing end to end), `dispatcher.params.test.ts` (allow-lists, refusals, a property test),
`dispatcher.dedupe.test.ts`, `dispatcher.recipients.test.ts`, `dispatcher.digest.test.ts`,
`dispatcher.isolation.test.ts`, `dispatcher.payload.contract.test.ts`; the store's parts also on
Postgres 16 (CI). The jobs: `apps/worker/test/notify-dispatch.test.ts` (with Redis 7 in CI).
