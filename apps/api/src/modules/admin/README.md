# Internal admin API (B087)

Staff tooling on its own listener: `/internal/admin/v1` (routes in
[`routes/internal-admin.ts`](../../routes/internal-admin.ts)). The operator's guide is
[docs/admin/admin-api.md](../../../../../docs/admin/admin-api.md).

## Pieces

| File            | What it does                                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| `staff.ts`      | `requireStaff(minRole)`: token, `admin` scope, staff row (5 s cache), rate, reason.   |
| `call.ts`       | One call as its `staff.access` event records it; outcomes.                            |
| `actions.ts`    | The `staff.access` action and its meta allowlist.                                     |
| `repository.ts` | Reads (allowlisted columns), writes, and the audit rows, in one transaction.          |
| `service.ts`    | What each route does, and its body (types in `types.ts`).                             |
| `redact.ts`     | E-mail masking for `support_ro`, and the scrub every body goes through.               |
| `ports.ts`      | Tokens (B017), entitlements (B069), flags (B083), status (B086), invites, promotions. |
| `login-gate.ts` | B017's `signInGate`: no tokens for a user staff disabled.                             |
| `cidr.ts`       | The listener's connection allowlist.                                                  |
| `config.ts`     | `ADMIN_API_ENABLED`, `ADMIN_API_PORT`, `ADMIN_ALLOWED_CIDRS`.                         |

Migration: `20260102002900_staff_users.sql` (`staff_users`, `staff_audit_details`, the `staff`
actor, `users.login_disabled_at`, `refresh_tokens.revoked_reason`).

## Rules

- Every request writes exactly one `staff.access` event before its response leaves (reads in
  `onSend`, writes before the action in the transaction that commits it). No event, no answer.
- No content, keys, tokens, secrets or payment data in any body; no impersonation.
- Staff records: `superadmin` only, never one's own. Another staff member's account: `superadmin`.

## Tests

`apps/api/test/admin/`: `admin.routes.test.ts` (authz matrix, audit completeness over every
registered route, reasons, masking, roles, redaction scan, revocation, flags and incidents,
failures, impersonation, rate limit, staff audit), `admin.listener.test.ts` (CIDR allowlist on
real sockets, disabled, public listener), `admin.units.test.ts`, and on Postgres
`admin.postgres.test.ts`.
