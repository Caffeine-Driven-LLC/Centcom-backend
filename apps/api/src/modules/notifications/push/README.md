# Push delivery (B064)

Delivers notifications ([CT-NOTIF-PAYLOAD](../../../../../../contracts/08-integrations.md)) to a
user's devices by web push, APNs or FCM, and serves the push subscription routes of CT-API-NOTIFY
([02-rest-api.md](../../../../../../contracts/02-rest-api.md)).

## Pieces

| File                  | What it does                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry.ts`         | `push_subscriptions`. It checks registrations, de-duplicates (one row per user and endpoint/token), caps each user at 10, seals the endpoint/token and keys at rest, and counts failures. |
| `sender.ts`           | `PushSender` is B063's `PushSenderPort` and queues one `notify.push` job per notification and user. `PushDelivery.process` delivers a job.                                                |
| `providers.ts`        | The provider interface and outcomes, the per-provider semaphore and circuit breaker, and the SSRF guard.                                                                                  |
| `webpush-provider.ts` | RFC 8030 delivery with RFC 8291 `aes128gcm` encryption and RFC 8292 VAPID.                                                                                                                |
| `apns-provider.ts`    | APNs over HTTP/2 with an ES256 provider token.                                                                                                                                            |
| `fcm-provider.ts`     | FCM HTTP v1 with a service-account OAuth token.                                                                                                                                           |
| `config.ts`           | The `PUSH_*` keys.                                                                                                                                                                        |

Routes: `routes/push/index.ts` (`POST` and `DELETE /v1/push/subscriptions`). Worker:
`apps/worker/src/jobs/notify-push.ts`.

## Rules

- **The payload** is the CT-NOTIF-PAYLOAD fields only: ids, keys, enums and integers, never
  display text. `params` is cut to the category's allow-list (B063 `PARAM_RULES`) and string
  fields are capped. The payload is at most 2 816 bytes before the provider wraps or encrypts it,
  so no request body exceeds 3 072 bytes.
- **Outcomes:**
  - 2xx is sent;
  - 404/410, APNs `Unregistered` or `BadDeviceToken`, and FCM `UNREGISTERED` are gone, and the
    subscription is deleted;
  - 408/429/5xx and timeouts (10 s) retry: 3 retries, full-jitter backoff with base 1 s and cap
    30 s, then counted on the subscription, the fifth in a row within 24 h deleting it;
  - other 4xx (bad credentials, wrong topic) are failed and not counted.
- **Guards:** each provider has a semaphore (`PUSH_CONCURRENCY_PER_PROVIDER`, default 20 sends in
  flight) and a circuit breaker (10 failed sends in a row open it for 60 s). While a circuit is
  open, its deliveries are deferred: the job re-queues them, delayed, rather than dropping them.
- **SSRF:** web-push endpoints are https on a public host when registered. At send time every
  resolved address must be public, and redirects are not followed.
- **Privacy:** endpoints, tokens and keys are sealed (AES-256-GCM, bound to the row id), never
  returned and never logged. Logs carry the subscription id and the provider.

## Configuration

| Key                                                                                                     | Notes                                                                   |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `PUSH_ENCRYPTION_KEY`                                                                                   | Required; 32 bytes, base64.                                             |
| `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_VAPID_SUBJECT`                                 | Web push; all or none. The pair is checked.                             |
| `PUSH_APNS_TEAM_ID`, `PUSH_APNS_KEY_ID`, `PUSH_APNS_PRIVATE_KEY`, `PUSH_APNS_TOPIC`, `PUSH_APNS_ORIGIN` | APNs; all or none (the origin has a default). The key must be EC P-256. |
| `PUSH_FCM_SERVICE_ACCOUNT`, `PUSH_FCM_ORIGIN`                                                           | FCM; the service account JSON with an RSA key.                          |
| `PUSH_CONCURRENCY_PER_PROVIDER`                                                                         | Default 20.                                                             |

A provider whose keys are all absent is off: its subscriptions are kept and skipped. Partial or
unusable keys are a ConfigError, so the API refuses to start.

## Wiring

```ts
const push = loadPushConfig();
const registry = new PushRegistry({ db, key: push.encryptionKey });
const delivery = new PushDelivery({
  registry,
  concurrency: push.concurrency,
  logger,
  metrics,
  providers: {
    ...(push.vapid && { web_push: new WebPushProvider({ vapid: push.vapid }) }),
    ...(push.apns && { apns: new ApnsProvider({ config: push.apns }) }),
    ...(push.fcm && { fcm: new FcmProvider({ config: push.fcm }) }),
  },
});
// API: new PushSender(createNotifyPushQueue(connection)) as B063's `push` port; register pushRoutes.
// Worker: startNotifyPushWorker(connection, { process: (d) => delivery.process(d), queue }).
```

## Tests

`apps/api/test/notifications/push/`:

- `webpush`: the RFC 8291 vector, VAPID, and decrypted bodies.
- `apns`: a local HTTP/2 server.
- `fcm`: stubbed endpoints.
- `sender`: retries, the circuit breaker, and 1 000 pushes within the concurrency limit.
- `providers`: the SSRF guard, the semaphore and the breaker.
- `config`, `routes`, and `postgres` (when `DATABASE_URL` is set).

`apps/worker/test/notify-push.test.ts` covers the worker job.
