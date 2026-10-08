# Notification preferences (B066)

A user's channel switches and quiet hours
([CT-API-NOTIFY](../../../../../../contracts/02-rest-api.md) `NotificationPreferences`, rules in
[CT-NOTIF-PAYLOAD](../../../../../../contracts/08-integrations.md)). The routes read and replace
them, and B063's dispatcher reads them through `PreferencesPort`.

## Pieces

| File             | What it does                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `schema.ts`      | The document: defaults, validation (422 with pointers), the inbox rule, and lenient reading of stored documents.       |
| `quiet-hours.ts` | `isQuietNow(prefs, now)` in the user's IANA zone, `canonicalTimeZone`, and `quietHoursPort` (B063's `QuietHoursPort`). |
| `service.ts`     | `PreferencesService`: `read`, `replace` (If-Match) and `get` (B063's `PreferencesPort`).                               |
| `repository.ts`  | `notification_pref`: one row per user, versioned.                                                                      |

Routes: `routes/notification-preferences/index.ts`, scope `profile`, users only (an API key is
403).

| Route                              | Answer                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/notification-preferences` | 200 with the complete document and its ETag (`"v0"` before the first save).                                                         |
| `PUT /v1/notification-preferences` | Replaces the document; 200 with what was stored and the new ETag. 422 for a bad document, 413 over 8 KiB, 412 for a stale If-Match. |

## The document

```json
{
  "channels": { "approval_needed": { "inbox": true, "push": true, "email": false, "os": true } },
  "quiet_hours": {
    "enabled": true,
    "start": "22:00",
    "end": "07:00",
    "timezone": "Europe/Berlin",
    "allow_approval_needed": false
  }
}
```

- **Categories:** the 14 of CT-API-NOTIFY. `trial_ending` has no switches and always uses its
  default.
- **Channels:** `inbox`, `push`, `email`, `os` (`os` is client-local).
- **Switches** are booleans per channel, as the contract defines them (not the card's arrays).
- **Defaults** (code constants, never rows): approval_needed → inbox, push, os; billing_issue →
  inbox, email; the rest → inbox; quiet hours off.
- **Complete when stored and returned:** every category with all four switches; what a PUT
  leaves out takes its default.
- **Inbox stays on** for `security_alert` and `billing_issue`, whatever is sent. B063's routing
  also keeps quiet hours away from them.
- **Quiet hours** are `[start, end)` in local wall-clock time and may cross midnight. Turning them
  on needs `start`, `end` (different) and `timezone`. Zones must be IANA names, stored in their
  canonical spelling. Offsets such as `+01:00` are refused, though `Intl` would take them.
- **Unknown fields** are ignored and not stored. Unknown categories and channels are 422.

## Versions and ETags

The ETag is `"v<version>"`. The version is 0 before the first save, 1 after it, and goes up by
one on every write.

- With `If-Match`, the write is a compare-and-set in SQL, so of concurrent writers on one ETag,
  one wins and the rest get 412. `*` always matches; weak ETags never do.
- Without `If-Match`, the last write wins.

## Failures

- **A stored document that no longer validates** (an older shape): its valid parts are kept, the
  rest falls back to the defaults, and `notification_prefs.stored_invalid` is logged with the
  user id and the dropped pointers (no values). It is never a 500.
- **A database timeout or lost connection** is a 503 with `retry_after_s`.

## Wiring

```ts
const preferences = new PreferencesService({
  repository: createPreferencesRepository(db),
  logger,
});
await app.register(notificationPreferenceRoutes, { preferences });
// B063: new NotificationDispatcher({ ..., preferences, quietHours: quietHoursPort })
```

## Tests

`apps/api/test/notifications/preferences/`:

- `prefs.defaults`: the contract defaults and categories.
- `prefs.validation`: pointers, invariants, size, rate limit, auth, stale documents and 503.
- `prefs.quiet-hours`: overnight windows, DST in three zones, and properties.
- `prefs.etag`: ETag and If-Match, on Postgres too.
- `prefs.contract`: agreement with B063's routing.
