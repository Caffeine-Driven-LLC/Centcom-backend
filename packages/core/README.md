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
  `defineConfig(...)`) in `apps/*/src/main.ts`, then pass the result on. Lint rejects `process.env`
  everywhere except the config loader (`packages/core/src/config/`), entrypoints and `tools/`.
- **Declare your own keys in your own module**, with `defineConfig`. Don't edit the base schema.
  Give every key `.meta({ description, example })` and add the schema to `SECTIONS` in
  `scripts/gen-config-docs.ts` so it appears in `docs/config.md` and `.env.example`.
- **Wrap secrets** with `secretString()`. Never put a value in a refinement message; messages are
  shown to operators. A message that does contain the value is scrubbed, but don't rely on that.

### Behaviour

- Blank values count as unset. Missing required keys and invalid values are collected and thrown
  together, as one `ConfigError`.
- **`KEY_FILE` secrets.** Any key can be given as `KEY_FILE=<path>`:
  - the file wins over `KEY`, and trailing newlines are removed
  - a file that is missing, unreadable, not a regular file, or larger than 64 KiB is reported
    against `KEY_FILE`, without the path
  - in production, a world-readable secret file produces a warning. Warnings go to
    `process.emitWarning` until B005 wires in the logger; pass `onWarning` to route them.
- **TLS in production.** `DATABASE_URL` needs `sslmode=require` (or `verify-ca`, `verify-full`) and
  `REDIS_URL` needs `rediss://`. `ALLOW_INSECURE_BACKENDS=1` overrides both.
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
