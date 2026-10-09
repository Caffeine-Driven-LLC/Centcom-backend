# Relay privacy (B050)

Proves and enforces that the relay never handles plaintext work content. It has four parts:

- a privacy gate on the frame path;
- a deny-by-default log scrubber;
- a metric label guard;
- an architecture guard against decrypting code.

A canary suite fails the build if a plaintext canary turns up anywhere outside ciphertext
([CT-CRYPTO](../../../../contracts/05-crypto.md) "What the server stores",
[CT-WS-SESSION-EVENTS](../../../../contracts/04-session-events.md) privacy budget). The gate is a
relay module (`module.ts`, order 30 = `STAGE_ORDER.privacy`). The scrubber and the guard are applied
by `startRelay` to every module.

## Parts

| File                             | What it does                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `sanitize.ts`                    | `sanitizeClearPayload(kind, p)`: only the catalogue's clear fields; the 8 KiB cap.           |
| `stage.ts`                       | The gate (30): rebuilds `p`, drops encrypted kinds' `p`, refuses oversized clear payloads.   |
| `logger.ts`                      | `createRelayLogger(base)`: every line's fields and child bindings filtered by the allowlist. |
| `metrics.ts`                     | `assertMetricLabels(name, labels)`, and `guardMetrics(base)` for the relay's metrics.        |
| `allowlists.ts`                  | The reviewed log fields and metric labels (deny by default).                                 |
| `../../scripts/privacy-guard.ts` | The architecture guard: an AST scan, with a non-zero exit on a finding.                      |
| `../../test/privacy/canary.ts`   | `privacyRelay()` and `privacyCanaryRun()`: the canary harness.                               |

## Rules

- **Gate** (order 30, after authorisation, before presence and sequencing). For a frame of a
  catalogued kind:
  - `p` keeps only the fields of the kind's cleartext column, in the order they came;
  - an encrypted kind keeps no `p` (B039 already refuses one; the gate removes it if one ever gets
    through);
  - every dropped field is counted (`relay_privacy_violations_total{where="frame"}`), and the frame
    goes on without it: the field is dropped, not the frame. Logs carry the kind only.

  A clear `p` over 8 KiB is `invalid_frame` (pointer `/p`), whatever the kind, except the
  server-built `queue.state` and `control.roster`. An unknown kind's `p` is carried as it came
  (opaque), and only the size cap applies.

- **Log scrubber** (deny by default).
  - Each line keeps only the allowlisted fields, at any depth up to 5, at every level including
    debug and trace. That's the card's 11 fields plus the relay's operational ones: counts, codes,
    reasons, seq ranges, error class names.
  - `ct`, `p`, `c`, `n`, `sig`, `ticket`, `text`, `path` and anything else not listed are dropped.
  - Circular objects are cut, never followed, and the scrubber never throws.
  - B005's own redaction still runs after it (it also hides `code`, for example).
  - A test scans every log call in the relay's source and fails if a field is not allowlisted. A
    new field is a reviewed change to `allowlists.ts`.
- **Metric label guard.**
  - A label must be one B093's catalogue declares for a relay metric. Its value must not look like
    an id (`ses_…`, `mem_…`) or be longer than 64 characters.
  - `assertMetricLabels` throws. `guardMetrics` drops the label (never written) and counts
    `relay_privacy_violations_total{where="metric"}`.
- **Architecture guard.** It reports any import of a decrypting library (`sodium-native`,
  `libsodium-wrappers`, `tweetnacl`, `@noble/ciphers`, ...), any decrypting primitive
  (`crypto_aead_*_decrypt*`, `crypto_box_seal_open`, `crypto_box_open*`, `crypto_secretbox_open*`,
  `createDecipheriv`), and any key-material environment name, under `apps/relay/src`.
  - It sees static imports, re-exports, dynamic `import()` and `require`.
  - It lives outside `src`, so its own lists don't flag it.
  - The real tree passes.
- **Canary suite.** The relay runs every kind a client may send, with a unique canary in `ct.c`,
  in every secret field and in an extra `p.note`. It then scans these for the canary:
  - the log (at trace level) and metric labels;
  - the hot buffer and the durable-append port, outside `ct`;
  - error frames;
  - other members' clear parts.

  It also checks that the canary did travel inside `ct`, and that no metric label holds `ses_` or
  `mem_`. Two negative controls prove the suite can fail:
  - a module that logs `ct.c` under an allowlisted field is reported;
  - a module that logs `{ ct }` is scrubbed.

- **Vectors.** `fixtures/crypto/vectors.json` is checked for structure only (the relay opens
  nothing): nonce 24 bytes, ciphertext = plaintext + 16, signature 64, keys 32. A frame built from
  them passes the envelope.

## Running

```bash
pnpm --filter @centcom/relay test:privacy
```

This runs `apps/relay/test/privacy` and the architecture guard, which exits 1 on a finding. Both
also run in `pnpm test`; making them a required CI check is a workflow change for a human.

## Metrics

`relay_privacy_violations_total{where}`: `frame`, `size`, `metric`.

## Testing

`apps/relay/test/privacy/`:

- `privacy.canary`: the full run, plus the two negative controls.
- `privacy.sanitize`: a per-kind table generated from the catalogue, every fixture, a property
  test with random extra fields, encrypted and unknown kinds, the 8 KiB cap, the 0.2 ms p95.
- `privacy.logger`: nesting, cycles, every level, child bindings, and the AST scan of the relay's
  log fields.
- `privacy.metrics`: the label rules and the wrapped metrics.
- `privacy.architecture`: forbidden imports, calls and env names; the script's exit code.
- `privacy.vectors`: crypto vector structure.
