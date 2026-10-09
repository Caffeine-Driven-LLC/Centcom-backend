# Audit log API (B082)

The workspace audit log of [CT-API-AUDIT](../../../../../contracts/02-rest-api.md): a filtered,
paginated read of B036's `audit_events`, and asynchronous CSV or JSON exports to object storage.
The operator's guide is [docs/audit/audit-api.md](../../../../../docs/audit/audit-api.md).

## Pieces

| File              | What it does                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `actions.ts`      | `AUDIT_API_ACTIONS`: B036's catalogue plus `audit.export`, for this module's emitter only.  |
| `config.ts`       | `loadAuditApiConfig`: the export limits and the object store's keys (`@centcom/storage`).   |
| `filters.ts`      | `actor`, `action`, `from`, `to` for the list and the export body; the cursor's filter hash. |
| `present.ts`      | Rows as contract `AuditEvent`s (ids, enums and allowlisted meta only).                      |
| `csv.ts`          | The export formats: CSV (RFC 4180, formula guard) and JSON, one event at a time.            |
| `repository.ts`   | The SQL: the list, the capped count, export batches, and `audit_export_jobs`.               |
| `service.ts`      | `AuditApiService`: retention, the list, export requests and their status.                   |
| `exporter.ts`     | `AuditExportRunner`: writes, uploads and expires export files (the worker calls it).        |
| `object-store.ts` | The `ObjectStore` port and its S3 client (path-style, SigV4; R2 or MinIO).                  |

The SigV4 signer (`sigv4.ts`) lives in `@centcom/storage` since B042, shared with the history
store's S3 client.

Routes: `routes/audit.ts`. Worker: `apps/worker/src/jobs/audit-export/`. Migration:
`20260102002400_audit_export_jobs.sql`.

## Wiring

```ts
const repository = createAuditRepository(db);
const store = createS3ObjectStore(config.objectStore);
const exportQueue = createAuditExportQueue({ connection }); // @centcom/worker
const audit = new AuditApiService({
  repository,
  retentionDays: retentionFromEntitlements(app.entitlements), // B080
  emitter: createAuditEmitter({ db, actions: AUDIT_API_ACTIONS, logger, metrics }),
  queue: { enqueue: (id) => enqueueAuditExport(exportQueue, id) },
  store,
  cursorKeys: paginationConfig().signingKeys,
  maxRows: config.maxRows,
  urlTtlS: config.urlTtlS,
});
await app.register(auditRoutes, { audit });

// In the worker process:
const runner = new AuditExportRunner({
  repository,
  store,
  maxRows: config.maxRows,
  retainMs: config.retainMs,
});
startAuditExportWorker({
  connection,
  queue: exportQueue,
  run: (id, o) => runner.run(id, o),
  sweep: (now) => runner.sweep(now),
});
await scheduleAuditExportSweep(exportQueue);
```

## Rules

- **Who:** scope `audit:read` and the `audit.read` RBAC action (owners and admins; a denial of a
  member is audited as `permission.denied`). Non-members get 404.
- **Plan:** `audit_log_days` from the workspace's entitlements. 0 refuses the list and new exports
  with 403 `entitlement_required`. Otherwise only events of the last `audit_log_days` days are
  read, and the horizon is a condition of every statement.
- **Reads write no audit event.** An export request writes `audit.export` (target the export,
  meta `format`, `gzip` and the names of its filters) in the transaction that stores the export.
- **No PII:** events show ids, enums, action names and their allowlisted meta, cut again on the
  way out. The table holds no IP addresses, user agents or e-mail addresses.
- **Exports are streamed:** keyset batches of 5 000 into a temporary file, uploaded whole in one
  PUT. The file name is the export id, so a retry replaces it, and every attempt first removes
  what an earlier one left.

## Tests

`apps/api/test/audit-api/`: `audit.routes.test.ts` (authorisation matrix, plan, retention,
filters, pagination of 10 000 with inserts, cursors, export requests), `audit.export.test.ts`
(files, row cap, storage down, a killed worker, URL lifetime, expiry), `audit.units.test.ts`
(filters, cursor binding, CSV, mapping, SigV4 against AWS's examples, configuration),
`audit.s3.test.ts` (the S3 client against a signature-checking server). On Postgres
(DATABASE_URL): `audit.postgres.test.ts` (SQL scoping, pagination, the export transaction, an
export of 100 000 events within 60 s) and `audit.perf.test.ts` (1 000 000 events, p95 and EXPLAIN).
With a container runtime: `audit.minio.test.ts` (MinIO). The worker's: `apps/worker/test/audit-export.test.ts`.
