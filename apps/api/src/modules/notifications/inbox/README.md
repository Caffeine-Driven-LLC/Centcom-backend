# In-app inbox (B065)

The inbox REST API of [CT-API-NOTIFY](../../../../../../contracts/02-rest-api.md): a user's
notifications as [CT-NOTIF-PAYLOAD](../../../../../../contracts/08-integrations.md), newest first.
B063's dispatcher writes them; the inbox only reads them and marks them read.

## Routes

`routes/notifications/index.ts`, scope `profile`, users only (an API key is 403):

| Route                                          | Answer                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /v1/notifications?unread=&limit=&cursor=` | CT-PAGE `{data, next_cursor, has_more}`, 50 by default (1 to 200), with `X-Unread-Count`. |
| `POST /v1/notifications/{id}/read`             | 200 with the notification. Marking it again keeps the first `read_at`.                    |
| `POST /v1/notifications/read-all`              | 200 `{updated}`: how many it marked (0 the second time).                                  |

## Rules

- **Isolation:** every statement has the caller's user id (from the token) in its WHERE clause.
  Another user's notification, an unknown id and a malformed id are all 404, so ids cannot be
  probed.
- **What shows:** rows holding the `inbox` channel, created in the last 90 days
  (`INBOX_RETENTION_MS`). Older rows are hidden before B090 purges them, and the unread count
  ignores them too.
- **Payload:** the CT-NOTIF-PAYLOAD fields only. `params` is cut to the category's allow-list
  (B063 `PARAM_RULES`) on the way out as well as on the way in. `title_key`/`body_key` are
  `notif.<category>.title|body`; no display text is stored or sent.
- **Paging:** B025's keyset pagination on `(created_at, id)`, newest first. Cursors are signed,
  expire after 24 h, and are bound to the user and the `unread` filter. Another user's, another
  filter's, an expired or a tampered cursor is 400 `cursor_invalid`. `limit` outside 1..200 is 422.
- **Read-all** marks the unread rows that exist when it starts (`created_at <= now`), oldest first,
  at most 500 per statement (`READ_ALL_BATCH_SIZE`). Each batch is its own short statement that
  skips rows another transaction holds. It answers only after the last batch; a failure part-way
  is a 503, never a partial count.
- **Failures:** a statement timeout or a lost connection is 503 with `retry_after_s`.

## Indexes

- B063's `notifications_user_id_created_at_idx (user_id, created_at, id)` serves the plain list.
- `notifications_inbox_unread_idx` (migration `20260102001800`, partial on
  `read_at is null and 'inbox' = any (channels)`) serves `unread=true`, the unread count and
  read-all's batches. The queries write those conditions as literals so the planner can match the
  index.

## Wiring

```ts
const inbox = new InboxService({
  repository: createInboxRepository(db),
  cursorKeys: paginationConfig().signingKeys,
});
await app.register(notificationRoutes, { inbox });
```

Register it after the request-context, error-handler and auth plugins.

## Tests

`apps/api/test/notifications/inbox/`:

- `inbox.list`: paging, the unread filter, ordering, retention, limits and cursors.
- `inbox.isolation`: cross-user access, ids and auth.
- `inbox.read`: idempotent read, read-all and its batches, and 503s.
- `inbox.contract`: responses against the generated types and the schema.
- `inbox.perf`: 200 of 100 000 rows within 50 ms, on an index.

`inbox.list`, `inbox.isolation` and `inbox.read` also run on Postgres when `DATABASE_URL` is set;
`inbox.perf` runs only there.
