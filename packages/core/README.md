# @centcom/core

Shared platform primitives for the backend services. Today this is configuration (lane B004).
Logging (B005), errors (B006), Redis (B009) and the rest arrive with their lanes.

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

Invalid configuration must stop the process before it opens a port:

```ts
// apps/<service>/src/main.ts
import { baseConfig, ConfigError } from '@centcom/core';

let config;
try {
  config = baseConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message); // key names and problems only
    process.exit(1);
  }
  throw e;
}
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
