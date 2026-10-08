# Webhook delivery

Owner: lane B081. How Centcom delivers outgoing webhooks
([CT-WEBHOOKS](../../contracts/08-integrations.md)), and what an operator sees when a receiver
misbehaves.

## Pipeline

```
emitWebhookEvent ──► webhook.events ──► fan-out ──► webhook_deliveries (pending)
     │ Redis down                                   │
     ▼                                              ▼
 webhook_outbox ──(every 30 s)──►              webhook.deliver (one job per attempt)
                                                    │ 2xx            │ failure
                                                    ▼                ▼
                                                delivered    next attempt (1 m … 24 h)
                                                             └─ 7th retry fails ─► failed + webhook.dead
```

- **At-least-once and unordered.** Receivers dedupe on the body's `id` (= `Centcom-Event-Id`,
  constant across retries of one delivery).
- **Fan-out is idempotent by event id.** A redelivered `webhook.events` job writes nothing new.
- **A job for an attempt that was already made does nothing.** Attempts are compare-and-set on
  their number.

## Retry schedule

| Retry | Delay (±10 %) |
| ----- | ------------- |
| 1     | 1 min         |
| 2     | 5 min         |
| 3     | 30 min        |
| 4     | 2 h           |
| 5     | 6 h           |
| 6     | 12 h          |
| 7     | 24 h          |

These are about 45 hours in all. Non-2xx, 3xx (redirects are never followed), a timeout (10 s), a
refused connection and a blocked destination all count as failures.

## Endpoint health

| State      | Meaning                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`   | Delivering, or failures not yet final.                                                                                                                                                                         |
| `failing`  | A delivery failed every retry. Deliveries continue.                                                                                                                                                            |
| `disabled` | Failing for 3 consecutive days with no success. No new deliveries; queued ones end `failed` (`endpoint_disabled`). The owners got one e-mail and the audit log one `webhook.update` (system actor `webhooks`). |

To recover, fix the receiver, then `PATCH /v1/webhooks/{id} {"enabled": true}` and redeliver from
the log (`POST /v1/webhooks/{id}/deliveries/{dlv}/redeliver`) what is needed.

## Security

- **SSRF:** endpoint URLs must be `https`, at most 2048 characters, without credentials.
  - Every address the host resolves to must be public, on create (422 `webhook_url_invalid`)
    and again on every attempt (`blocked_destination`). Refused: private, loopback, link-local,
    CGNAT, metadata (169.254.169.254) and unique-local (fc00::/7), including IPv4-mapped forms.
  - Each attempt connects to the address it checked, with the original name for Host and SNI, so
    DNS rebinding cannot redirect it.
- **Test mode:** `WEBHOOK_ALLOW_LOOPBACK=true` allows `http://127.0.0.1`, `[::1]` and `localhost`
  receivers for local testing; production refuses to start with it.
- **Secrets:** `whsec_…`, shown once (create, rotate), stored AES-256-GCM sealed under
  `WEBHOOK_SECRET_KEY`. After rotation both signatures are sent for 24 h.
  - If the key is wrong or missing, deliveries pause (nothing unsigned is sent) and
    `webhook_secret_unavailable_total` rises: alert on it.
- **Logs and storage:** no secrets, signatures, request bodies or response bodies in logs. The
  delivery log keeps at most the first 1 KiB of a response, without control characters.
  Payloads hold ids, enums, counts and names only.
- **Fairness:** at most 5 attempts in flight per endpoint and 20 per workspace, and responses are
  read up to 64 KiB.

## Metrics

| Metric                             | Watch for                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `webhook_attempts_total{result}`   | `result` is `delivered`, `http_status`, `timeout`, `connection`, `redirect` or `blocked_destination`. |
| `webhook_deliveries_created_total` | Fan-out volume.                                                                                       |
| `webhook_deliveries_dead_total`    | Deliveries that failed every retry.                                                                   |
| `webhook_endpoints_disabled_total` | Endpoints turned off.                                                                                 |
| `webhook_secret_unavailable_total` | Must stay 0; anything else means the key is wrong.                                                    |
| `webhook_jobs_failed_total{queue}` | Job crashes (a bug or a database problem).                                                            |

## Configuration

| Key                      | Notes                                         |
| ------------------------ | --------------------------------------------- |
| `WEBHOOK_SECRET_KEY`     | Required; 32 bytes, base64.                   |
| `WEBHOOK_ALLOW_LOOPBACK` | `false` (default) or `true` (test mode only). |
