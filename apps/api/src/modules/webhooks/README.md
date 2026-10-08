# Outgoing webhooks (B081)

Endpoint management ([CT-API-WEBHOOKS](../../../../../contracts/02-rest-api.md)) and delivery
([CT-WEBHOOKS](../../../../../contracts/08-integrations.md)). Operators' guide:
[docs/webhooks/delivery.md](../../../../../docs/webhooks/delivery.md).

## Pieces

| File             | What it does                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `config.ts`      | `WEBHOOK_SECRET_KEY` (seals signing secrets), `WEBHOOK_ALLOW_LOOPBACK` (test mode, refused in production). |
| `destination.ts` | The SSRF rules: URL shape, every resolved address public, checked again on each attempt.                   |
| `http.ts`        | One attempt: connect to the checked address, 10 s, no redirects, 64 KiB read, 1 KiB kept.                  |
| `repository.ts`  | `webhook_endpoints`, `webhook_events`, `webhook_deliveries`, `webhook_outbox`.                             |
| `service.ts`     | `WebhookService`: endpoints, fan-out, attempts and retries, health, test, redeliver.                       |

Also `routes/webhooks.ts`; `@centcom/core`'s `webhooks/` (`emitWebhookEvent`, `signPayload`, the event
vocabulary, also published as `@centcom/core/webhooks`); and the worker's `jobs/webhooks/`.

## Emitting

```ts
const emitWebhookEvent = createWebhookEventEmitter({
  queue: webhookQueues.events,
  outbox: { write: (e) => repository.writeOutbox(e) },
});
await emitWebhookEvent({
  type: 'session.created',
  workspace,
  data: { session, host, name, state },
});
```

`data` may hold only the fields CT-WEBHOOKS lists for the type: ids, enums, counts and names
(`WEBHOOK_DATA_FIELDS`). Anything else is refused before it is queued. With Redis down, the event
goes to `webhook_outbox`, and the worker drains it every 30 s.

## Delivery

- **Body:** `{id, type, created_at, workspace, api_version, data}`, where `id` is the delivery's
  `dlv_` id. Headers: `Centcom-Event-Id` (the same `id`), `Centcom-Event-Type`,
  `Centcom-Delivery-Attempt` (1, 2, …) and
  `Centcom-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`.
- **Retries:** after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h and 24 h (±10 %). The 7th retry's failure ends
  the delivery `failed` and parks it on `webhook.dead`. A 2xx ends it `delivered` (the API's
  `succeeded`).
- **Health:**
  - a delivery that fails every try marks its endpoint `failing`;
  - after 3 days of failures with no success, the endpoint is disabled: the owners are e-mailed
    (`DisabledNotifier`) and a system `webhook.update` audit event is written, once;
  - re-enabling it (`PATCH enabled: true`) makes it `active` again.
- **Limits:** at most 5 attempts in flight per endpoint and 20 per workspace.
- **Secrets:**
  - shown only in the create and rotate responses, sealed at rest (AES-256-GCM, bound to the
    endpoint id);
  - after a rotation the old secret keeps signing for 24 h (two `v1` values);
  - if a secret cannot be opened, the delivery pauses rather than send unsigned
    (`webhook_secret_unavailable_total`).

## Wiring

```ts
const config = loadWebhookConfig();
const repository = createWebhookRepository(db);
const queues = createWebhookQueues({ connection }); // @centcom/worker
const service = new WebhookService({
  repository,
  config,
  queue: queues.deliver,
  limits: cachedEntitlements, // B080
  notifier, // e-mails the owners (B032)
  audit: auditEmitter, // B036, detached
  logger,
  metrics,
});
await app.register(webhookRoutes, { service, cursorKeys }); // after auth, RBAC, audit, idempotency
// Worker: startWebhookWorkers({ connection }, {
//   fanOut: (e) => service.fanOut(e),
//   attempt: (d, n) => service.attempt(d, n),
//   drainOutbox: repository.drainOutbox,
// }, queues);
// scheduleWebhookOutbox(queues.outbox)
```

## Tests

`apps/api/test/webhooks/`:

- `webhooks.delivery`: retries, signatures, ids, redirects, timeouts, secrets and concurrency,
  against a loopback receiver.
- `webhooks.ssrf`: create and delivery checks, including DNS rebinding, and test mode.
- `webhooks.health`: disabling after 3 days, once.
- `webhooks.payload.contract`: every event type against CT-WEBHOOKS, the emitter and the outbox.
- `webhooks.routes`: the HTTP API.
- `webhooks.postgres`: the SQL, in CI's integration job.

`apps/worker/test/webhooks.test.ts` covers the jobs.
