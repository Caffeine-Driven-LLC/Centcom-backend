# @centcom/contracts

Owner: lane B003. Turns `contracts/` into TypeScript types, precompiled validators, ID, time,
money and text helpers, and the error-code registry. No other lane hand-writes a type that a
contract defines (GUIDELINES §2.2): import it from here.

Wire behaviour is defined by the contracts, not by this package; see [`contracts/`](../../contracts/).

## Public interface

Everything is exported from `@centcom/contracts` (the package's only entry point).

| Export | What it is |
|---|---|
| `validate(key, value, {mode?})` | Validates against one contract schema. Returns `Result<T>`: `{ok: true, value}` or `{ok: false, errors: [{pointer, code, detail}]}`. Never throws, never copies or mutates the value. |
| `validateEnvelope(frame)` | A WebSocket frame: `envelope.schema.json`, then `events.schema.json` (payload mode and cleartext payload per kind). Unknown kinds pass (CT-WS-SESSION-EVENTS). |
| `validateEvent(kind, p)`, `validateEventSecret(kind, secret)` | Cleartext payload and decrypted secret payload of one kind. Encrypted kinds take no `p`. Unknown kinds give `unknown_kind`. |
| `validateEntitlements`, `validateProblem`, `validateNotification`, `validateWebhook`, `validateTelemetry`, `validateReleaseManifest`, `validateLanPair`, `validateProviderPolicy` | One per schema file. |
| `EVENT_CATALOGUE`, `EVENT_KINDS`, `isEventKind` | Per kind: frame type `t`, payload mode (`encrypted`, `hybrid`, `clear`), the cleartext fields the relay may read, whether a secret schema exists. |
| Types | One per schema file (`Envelope`, `Entitlements`, `Problem`, ...), `<Kind>Payload` / `<Kind>Secret` for events, `EventKind`, `SchemaTypes`, `SchemaKey`, and every OpenAPI component as `Api.<Name>`. |
| `newId(prefix, deps?)`, `createIdGenerator(deps?)`, `parseId`, `isId`, `ID_PREFIXES`, `IdPrefix` | CT-IDS prefixed ULIDs. Generation is monotonic, even within a millisecond or if the clock goes backwards. Randomness comes from the CSPRNG; the clock and RNG are injectable for tests. |
| `formatTimestamp`, `parseTimestamp`, `isTimestamp` | Wire timestamps: exactly `YYYY-MM-DDTHH:mm:ss.sssZ`. |
| `money`, `parseMoney`, `isMoney`, `Money`, `Currency` | Integer minor units in USD or EUR. |
| `normaliseText`, `assertNoControlChars`, `hasControlChars`, `checkName`, `checkSlug`, `normaliseEmail`, `TEXT_LIMITS` | CT-IDS text rules. Lengths count code points after NFC normalisation. |
| `ERRORS`, `ErrorCode`, `ERROR_TYPE_BASE` | The CT-ERR registry from `errors.json`. |
| `STATE_MAP`, `PRODUCT_STATES`, `ProductState` | CT-STATE-MAP. |
| `CONTRACT_VERSION`, `CONTRACTS_LOCK_SHA256` | CT-VER build metadata. |

### Schema keys

| Key | Validates |
|---|---|
| a schema file stem, e.g. `envelope` | that schema file (`events` validates a whole frame) |
| `event/<kind>` | that kind's cleartext payload |
| `event-secret/<kind>` | that kind's decrypted secret payload |
| `api/<Name>` | an OpenAPI component, e.g. `api/Me` |

### Strict and tolerant validation

`strict` (the default) is exactly the schema. Use it for input you act on and for anything you
write: writers must not emit anything outside the schema.

`tolerant` also accepts unknown values of enums the contract documents as extensible. These are
enums whose description says consumers must tolerate unknown values: today `Role` and
`WebhookEventType`, and every schema that reaches them, such as `Member` or `MemberPage`. Use it
when reading data that a newer peer may have produced (the CT-VER robustness rule). The TypeScript
types list the known values only, so code must still handle "other".

### Issue codes

`pointer` is a JSON Pointer (RFC 6901) into the value. For a missing or extra property it points at
that property. `code` is one of: `required`, `invalid_type`, `invalid_value` (const/enum),
`invalid_format` (pattern/format), `out_of_range`, `too_short`, `too_long`, `too_few`, `too_many`,
`not_allowed`, `no_match` (oneOf), `invalid`. Three more describe the call itself: `unknown_schema`,
`unknown_kind`, `internal`. Validators stop at the first error, which keeps the work per invalid
input bounded.

## Generated code

`src/generated/` is output only. Never edit it.

```bash
pnpm contracts:gen     # regenerate from contracts/
pnpm contracts:check   # exit 1 if src/generated/ differs from a fresh run (also run by pnpm test)
```

| File | Content |
|---|---|
| `types.ts`, `api.ts` | Types from `schemas/*.json` and from `openapi.yaml` components |
| `validators.js` + `validators.d.ts` | Ajv standalone validators (JSON Schema 2020-12) |
| `errors.ts`, `state-map.ts`, `meta.ts` | Error registry, product states, version metadata |

How the generator works:
- **Precompiled validators.** The generator compiles every schema with Ajv at build time and emits
  standalone code. At runtime nothing is compiled, and there is no `eval` or `new Function`; a test
  runs the validators with `--disallow-code-generation-from-strings`.
- **Runtime helpers.** The validators load only Ajv's small runtime helpers and the `ajv-formats`
  checkers (`date`, `date-time`, `email`, `uri`), which is why `ajv` and `ajv-formats` are runtime
  dependencies.
- **Plain JavaScript.** `validators.js` is JavaScript because its functions are too long for the
  TypeScript compiler (it overflows its stack). It is imported through the package alias
  `#generated/validators`, so the same specifier works from `src/` (tests) and `dist/` (builds).
- **Strict input.** The generator accepts only an explicit list of JSON Schema keywords and
  formats. Anything else, a missing machine file, or a malformed event rule fails generation, names
  the file and keyword, and writes nothing. `openapi.yaml` and `errors.json` are skipped with a
  warning while absent.

## Configuration

None. The generator reads `contracts/` relative to the repository; `--contracts <dir>` and
`--out <dir>` exist for tests.

## Failure modes

- **Clock goes backwards, or a millisecond repeats:** ID generation stays monotonic by incrementing
  the previous random part, moving to the next millisecond if that overflows.
- **Hostile or exotic input:** every check returns `null`, `false` or a `Result` error and never
  throws. The only throws are for programming errors: `money()` with a bad amount,
  `formatTimestamp()` with an invalid Date, or an unknown prefix passed to `newId()`.
- **Stale generated code:** `pnpm test` fails, through `packages/contracts/test/generate.test.ts`
  and the root `contracts:check` test.

## Testing

`pnpm test` runs `packages/contracts/test/`:
- **IDs:** format and monotonicity over 1 000 000 IDs, and the prefix table compared with CT-IDS.
- **Time, money and text:** the CT-IDS examples and edge cases.
- **Fixtures:** every fixture in `contracts/fixtures/`, including removing each required field.
- **Property tests:** fast-check with a fixed seed, so failures reproduce.
- **Generator:** staleness, failure modes and the standalone guarantee.
