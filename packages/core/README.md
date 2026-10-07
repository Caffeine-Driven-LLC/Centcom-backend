# @centcom/core

Shared platform primitives for the backend services. Today this is configuration (lane B004) and
logging (B005). Errors (B006), Redis (B009) and the rest arrive with their lanes.

## Configuration (B004)

Every service reads its configuration once, at startup, through one typed loader. The keys, types
and defaults are listed in [`docs/config.md`](../../docs/config.md), which is generated from the
schemas.

### Public interface

| Export                                                           | What it is                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseConfig(env?, options?)`                                     | The base keys every service reads (`NODE_ENV`, `SERVICE_NAME`, `LOG_LEVEL`, `HOST`, `PORT`, `PUBLIC_API_URL`, `DATABASE_URL`, `REDIS_URL`, `TRUSTED_PROXY_HOPS`, `REQUEST_TIMEOUT_MS`, `ALLOW_INSECURE_BACKENDS`), returned as a deep-frozen `BaseConfig` |
| `defineConfig(schema, env?, options?)`                           | Parses the keys a `z.object()` schema declares; returns the deep-frozen result or throws `ConfigError`                                                                                                                                                    |
| `ConfigError`                                                    | Thrown for invalid configuration; `issues` lists `{key, problem}` for every problem, never a value                                                                                                                                                        |
| `Secret<T>`, `secretString(inner?)`                              | A value whose string, JSON and inspect forms are `[redacted]`; read it with `reveal()`                                                                                                                                                                    |
| `envInt({min, max})`, `envBool()`, `envUrl({protocols, plain?})` | Strict parsers for environment strings (no `1e3`, `0x10`, `yes` or relative URLs)                                                                                                                                                                         |
| `z`, `deepFreeze`, `DeepReadonly`, `Env`                         | zod (re-exported so lanes share one version) and helpers                                                                                                                                                                                                  |

### Rules

- **Read the environment only at the entrypoint.** Call `baseConfig()` (and your lane's own
  `defineConfig(...)`) in `apps/*/src/main.ts`, then pass the result on. Lint rejects reading the
  environment everywhere except the config loader (`packages/core/src/config/`), entrypoints and
  `tools/`. It catches `process.env`, `process['env']`, destructuring, `import { env }`, aliasing
  `process` to another name, `globalThis.process` / `global.process` and `process[key]`. It is a
  guardrail against mistakes, not a sandbox: deliberate indirection such as
  `Reflect.get(process, 'env')` is left to review.
- **Declare your own keys in your own module**, with `defineConfig`. Don't edit the base schema.
  Give every key `.meta({ description, example })` and add the schema to `SECTIONS` in
  `scripts/gen-config-docs.ts` so it appears in `docs/config.md` and `.env.example`.
- **Wrap secrets** with `secretString()`. Never put a value in a refinement message; messages are
  shown to operators. A message that does contain the value is scrubbed (values of 1-3 characters
  only as whole words), but don't rely on that.

### Behaviour

- Blank values count as unset. Missing required keys and invalid values are collected and thrown
  together, as one `ConfigError`.
- **`KEY_FILE` secrets.** Any key can be given as `KEY_FILE=<path>`:
  - the file wins over `KEY`. An empty file counts as unset; it does not fall back to `KEY`.
  - a UTF-8 byte-order mark and trailing newlines (`\n`, `\r\n`) are removed. Other whitespace is
    part of the value, exactly as for a `KEY` given directly.
  - the file is opened once (non-blocking, so a FIFO cannot hang startup). Its type, permission
    bits and at most 64 KiB + 1 bytes are read through that one handle, so the file cannot be
    swapped between check and read, and a file that misreports its size (procfs) is still capped.
  - a file that is missing, unreadable, not a regular file, or larger than 64 KiB is reported
    against `KEY_FILE`, without the path
  - in production, a world-readable secret file produces a warning. Group-readable files are
    deliberately silent: a service group is the usual way to share a secret, and warning on it
    would turn the warning into noise. Warnings go to `process.emitWarning` until B005 wires in
    the logger; pass `onWarning` to route them, and `readSecretFile` to replace file access in
    tests.
- **TLS in production.** `DATABASE_URL` needs exactly one `sslmode`, and it must be `require`,
  `verify-ca` or `verify-full`; a repeated `sslmode` is refused because drivers such as
  `pg-connection-string` use the last one. `REDIS_URL` needs `rediss://`.
  `ALLOW_INSECURE_BACKENDS=1` overrides both.
- **Strict `NODE_ENV`.** It is required, and an unknown value is an error; it is never mapped to
  `development`.

### Entrypoint pattern

Invalid configuration must stop the process before it opens a port. The logger's level and
service name come from the configuration, so warnings raised while loading it are collected and
logged once the logger exists:

```ts
// apps/<service>/src/main.ts
import { baseConfig, ConfigError, createLogger, type ConfigWarning } from '@centcom/core';

const warnings: ConfigWarning[] = [];
let config;
try {
  config = baseConfig(process.env, { onWarning: (w) => warnings.push(w) });
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message); // key names and problems only
    process.exit(1);
  }
  throw e;
}
const log = createLogger({
  level: config.logLevel,
  service: config.serviceName,
  env: config.nodeEnv,
  version: BUILD_VERSION,
});
for (const w of warnings) log.warn({ key: w.key, problem: w.problem }, 'config.warning');
```

### Docs and tests

```bash
pnpm --filter @centcom/core gen:config-docs   # rewrite docs/config.md and .env.example
pnpm test                                     # includes the freshness check for both files
```

`test/config/` covers:

- **`define.test.ts`:** aggregated errors, defaults, strict coercion, freezing
- **`secret.test.ts`:** redaction in every form
- **`file-secrets.test.ts`:** `KEY_FILE` handling
- **`base.test.ts`:** the base keys and the production rules
- **`docs-fresh.test.ts`:** the generated files

## Logging (B005)

Every service writes structured JSON logs, one line per event, through one logger created at the
entrypoint (see [Entrypoint pattern](#entrypoint-pattern)) and passed on. Each line goes through
`redact()` inside the logger before it is written, so no call site can log a token, key,
ciphertext, message body, path or branch name by accident (GUIDELINES §3.5), and there is no
unredacted logger to reach for. The request id, context and access log for the API live in
`@centcom/api` ([`apps/api/README.md`](../../apps/api/README.md)).

```json
{
  "level": "info",
  "time": "2026-10-06T18:07:41.123Z",
  "service": "api",
  "env": "production",
  "version": "1.4.2",
  "request_id": "req_01JA3Z8K2M5N7P9Q0R1S2T3V4W",
  "method": "GET",
  "route": "/v1/sessions/:id",
  "status": 200,
  "duration_ms": 4,
  "bytes": 40,
  "msg": "http.request"
}
```

### Public interface

| Export                                                   | What it is                                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createLogger({level, service, version, env?, ...})`     | The root logger. Options also take `destination` (default stdout), `metrics` (for `log_dropped_total`) and `now` (clock). Throws a `TypeError` for an unknown level                            |
| `Logger`                                                 | `fatal`/`error`/`warn`/`info`/`debug`/`trace(msg)` or `(fields, msg?)`, `child(bindings)`, `level`, `isLevelEnabled(level)`                                                                    |
| `redact(value)`                                          | A deep copy of any value that is safe to log; pure, never throws, never mutates its input                                                                                                      |
| `getRequestContext()`, `runWithContext(ctx, fn)`         | The current request's ids (`requestId`, and `userId`, `sessionId` once auth sets them), kept in AsyncLocalStorage; the logger adds them to every line as `request_id`, `user_id`, `session_id` |
| `Metrics`, `Counter`, `Histogram`, `noopMetrics`         | `counter(name, labels?).inc(n?)` and `histogram(name, buckets).observe(value, labels?)`; the no-op default stands in until the observability lane (B093) provides an exporter                  |
| `MAX_LOG_STRING_LENGTH`, `MAX_LOG_DEPTH`, ... `REDACTED` | The limits below and the placeholders `[redacted]`, `[unserialisable]` (`UNSERIALISABLE`), `[truncated]` (`TRUNCATED`)                                                                         |

### What redaction does

- **Deny-listed keys** lose their value, at any depth: `authorization`, `cookie`, `set-cookie`,
  `token`, `refresh_token`, `access_token`, `secret`, `password`, `api_key`, `ct`, `sig`, `text`,
  `p`, `body`, `path`, `branch`, `cwd`, `device_code`, `user_code`, `code_verifier`, `code`,
  `ticket` and `sec-websocket-protocol`. Keys are compared ignoring case, `-` and `_`
  (`refreshToken`, `API-KEY`). Compound names are caught too: keys ending in `token`, `apikey`,
  `privatekey`, `authorization`, `authcode`, `cookie(s)`, `credential(s)`, `signature`, `ticket`,
  `path(s)` or `branch(es)` (`id_token`, `x-api-key`, `file_path`), and keys containing `secret`,
  `password` or `passwd`. Short words (`p`, `ct`, `code`, `text`, `body`) match exactly only, so
  `status_code`, `tokens_in` and `context` stay readable.
- **Secrets inside strings** are replaced wherever they appear, in values, keys and messages:
  CT-AUTH API keys (`cen_live_…`, `cen_test_…`), JWTs and JWEs (`eyJ…` with two or more dots, with
  any text glued to them) and `Bearer` credentials (the scheme word stays).
- **Limits:** strings (and keys) are cut at 2 000 characters, ending in `…`; a credential that
  crosses the cut is dropped whole, never left half there. Objects more than 8 levels below the
  logged value become `[truncated]`, and so does everything after 100 000 copied entries.
- **Other values:** cycles and objects whose properties throw (getters, revoked proxies, failing
  `toJSON`) become `[unserialisable]`; `Secret`s and binary data (`Buffer`, typed arrays) become
  `[redacted]`; errors keep `type`, `message`, `stack`, their `code`, `cause` and other
  properties (redacted like everything else); URLs keep only origin and path; dates become ISO
  strings; bigints become strings.
- Redaction runs only for lines at an enabled level. A 1 MB object takes about 5 ms on a
  developer machine (the card's budget is 50 ms).

### Rules for callers

- **Put data in fields, not in the message.** Messages are redacted too, but fields are
  searchable: `log.info({ rows }, 'query.done')`.
- **Errors go under `err`:** `log.error({ err }, 'publish.failed')`.
- **Don't pass the keys the logger owns:** `level`, `time`, `msg`, `service`, `env`, `version`,
  `request_id`, `session_id`, `user_id`.
- **Ids only in the context.** A `userId` or `sessionId` that is not a CT-IDS id is logged as
  `[redacted]`.
- **Metric labels come from small fixed sets:** route templates, methods, status classes. Never
  an id, a raw path or any content.

### Failure modes

- **The destination fails** (an error, an ended stream, a write that throws): the line is
  dropped and counted in `log_dropped_total`; nothing is thrown into the caller. After a stream
  reports an error, every later line is dropped too.
- **The destination is slow:** at most 4 MiB (`MAX_LOG_BUFFER_BYTES`) of lines wait for it; later
  lines are dropped and counted. The default stdout writer is asynchronous and flushes on exit.
- **An unknown level** throws a `TypeError` at startup.

### Tests

`test/log/` covers:

- **`redact.test.ts`:** the deny list and its variants, the value patterns, the cap, cycles, the
  depth cap, exotic objects and the 1 MB budget (timed in a separate process by
  `redact-bench.ts`, away from coverage instrumentation)
- **`fuzz.test.ts`:** random and hostile values never make `redact()` throw; planted secrets never
  reach the output; the output is stable and serialisable
- **`logger.test.ts`:** the line format, redaction of fields, messages, errors and child
  bindings, the context ids, levels, and every destination failure
- **`context.test.ts`:** the context across `await`, timers and concurrent requests
- **`metrics.test.ts`:** the no-op default

Tests capture lines by passing a `Writable` as `destination`, fix the clock with `now`, and count
metrics with a recording `Metrics`.
