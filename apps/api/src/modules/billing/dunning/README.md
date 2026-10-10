# Dunning (B078)

The payment-failure lifecycle: `active → past_due → (active | none)` and `canceled → none at
period end`, with reminders on grace days 0, 3 and 6 and a wind-down of live hosted sessions 10
minutes after a drop. The rules, jobs, configuration, metrics and wiring are in
[`docs/billing/dunning.md`](../../../../../../docs/billing/dunning.md).

- `machine.ts`: the pure state machine (`decide`, `decideExpiry`, `dueReminders`).
- `service.ts`: `DunningService` (`applyBillingEvent`, `expire`, `remind`, `windDown`) and its
  ports (`SessionEnder`, `DunningScheduler`).
- `repository.ts`: the SQL (`subscription_dunning`, and moving B070's `past_due_since` back).
- `actions.ts`, `mail.ts`, `notice.ts`, `config.ts`: the audit action, the reminder email, the
  `plan_changed` notice and the configuration.

Failure modes: an event B072 cannot map to a workspace never reaches dunning; a failed reminder
send is retried by its job without repeating the other send; a drop the entitlements do not show
yet is announced by a later run; a failing SessionEnder fails the `wind-down` job, which is
retried and then dead-lettered.

Tests: `apps/api/test/billing/dunning/` (the transition table, the flows end to end in memory,
contracts and configuration, and Postgres 16 in CI's integration job) and
`apps/worker/test/dunning.test.ts`.
