# @centcom/testkit

The backend's test harness (lane B010): a migrated Postgres database and a Redis namespace per
test file, factories for the core schema (B008), a fake clock and seeded randomness, the contract
fixture runner and a Fastify `inject()` helper. Test-only: a package that uses it lists
`"@centcom/testkit": "workspace:*"` under `devDependencies`, and production code never imports it.

```ts
import { afterAll, beforeAll, beforeEach, it } from 'vitest';
import { createFactories, startTestStack, type TestStack } from '@centcom/testkit';

let stack: TestStack;
beforeAll(async () => {
  stack = await startTestStack({ reuse: true });
}, 180_000);
beforeEach(() => stack.reset());
afterAll(() => stack.stop());

it('lists the members of a workspace', async () => {
  const make = createFactories(stack.db);
  const workspace = await make.workspaces.create(); // and its owner, and the owner's membership
  await make.memberships.create({ workspace, role: 'admin' });
  // ... call the code under test with stack.db / stack.databaseUrl / stack.redisUrl
});
```

## Public interface

| Export                                                                                                                                    | What it is                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTestStack({reuse?, env?, runtime?})`                                                                                                | A new database `test_<unix time>_<random>`, migrated, and a Redis key prefix: `{databaseUrl, redisUrl, redisKeyPrefix, databaseName, db, reset(), stop()}` |
| `TestStack.reset()`                                                                                                                       | Truncates every table except `schema_migrations` and deletes the stack's Redis keys                                                                        |
| `TestStack.stop()`                                                                                                                        | Closes `db`, drops the database and deletes the Redis keys. Idempotent                                                                                     |
| `resolveTestServers(env?, runtime?)`                                                                                                      | The Postgres and Redis the stacks use: the env URLs, or containers started once per process for what is missing                                            |
| `reapStaleTestDatabases(url?, maxAgeMs?, now?)`                                                                                           | Drops `test_<time>_<random>` databases older than an hour (crashed runs); returns their names                                                              |
| `assertTestDatabaseName(name)`, `TestStackError`                                                                                          | The guard every destructive step passes first; the error a stack fails with                                                                                |
| `userFactory(db)`, `workspaceFactory(db)`, `membershipFactory(db)`, `deviceFactory(db)`, `sessionFactory(db)`, `sessionMemberFactory(db)` | `.create(...)` inserts one valid row and returns it, creating the rows it references when they are not given                                               |
| `createFactories(db, {ids?, clock?, random?})`                                                                                            | All six over shared dependencies; with a seeded generator and a fake clock every run gives the same rows                                                   |
| `createFakeClock(startIso?)`                                                                                                              | `{now(), advance(ms), set(iso), date()}`; starts at `DEFAULT_FAKE_TIME` (2026-01-01T00:00:00.000Z) and never reads real time                               |
| `createSeededRandom(seed)`                                                                                                                | `{uint32(), next(), int(min, max), bytes(n), pick(items), string(n, alphabet?)}`: the same values for the same seed on every platform                      |
| `seededIdGenerator(random, clock)`                                                                                                        | CT-IDS ids (`usr_...`) from a seeded random and a fake clock, monotonic like `createIdGenerator()`                                                         |
| `runFixtureSuite({fixturesDir, schemaFile, defKey?, register?})`                                                                          | Registers one vitest case per `*.json` fixture in `fixturesDir`, checking it against `schemaFile`                                                          |
| `checkFixture(file, {schemaFile, defKey?})`                                                                                               | The verdict on one fixture: `{ok, message}`                                                                                                                |
| `withApp(build)`                                                                                                                          | Builds a Fastify app in `beforeAll` and closes it in `afterAll`; `handle.app` inside a test, for `inject()`                                                |

## Where the servers come from

| DATABASE_URL and REDIS_URL      | Container runtime | Stacks run on                                                                         |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| both set (CI's integration job) | not used          | those servers; no container is started                                                |
| one or neither set              | Docker or Podman  | `postgres:16` and `redis:7` containers for what is missing, one pair per test process |
| one or neither set              | none              | `startTestStack` rejects at once with a `TestStackError` saying what to set           |

The Postgres user must be allowed to `CREATE DATABASE` (the `postgres` image's user is). Every
stack gets its own database and Redis key prefix, so test files running in parallel never see each
other's rows or keys; with `reuse: true` the calls of one test file (one worker) share a stack,
and the file calls `reset()` between tests. Without Docker and without the URLs, harness tests
that need servers are skipped (`describe.runIf`), as `test/harness/helpers.ts` shows.

**Failure modes.**

- **No container runtime and no URLs:** `startTestStack` fails in well under a second:
  `No container runtime (Docker or Podman) is reachable, and DATABASE_URL and REDIS_URL are not
both set. Start Docker, or set DATABASE_URL ... and REDIS_URL ...`. A failed start is not cached;
  the next call tries again.
- **A container is not ready within 60 s:** it fails with a `TestStackError` that quotes the
  container's last 50 log lines.
- **Leftovers of a crashed run:** containers carry the label `dev.centcom.testkit=true` and
  testcontainers' reaper removes them when the process that started them ends; throwaway
  databases older than an hour are dropped by the global setup and whenever a stack starts.

**Guardrails.** `reset()` and `stop()` touch only a database whose name matches
`test_<unix seconds>_<8 hex>` and that this process created; `reapStaleTestDatabases` drops only
names of that form. Factories make random keys per run (or seeded test data), never real secrets.
Beyond pulling the two images the harness needs no network; with both URLs set it needs none.

## Factories

Every factory inserts through `db` and returns the row as Postgres stored it (defaults filled).
What a factory needs and is not given, it creates: a workspace creates its owner and the owner's
`owner` membership, a session creates a workspace, a session member creates a user and a device
and takes the next free slot. Overrides are columns of the table:

```ts
const make = createFactories(stack.db);
const owner = await make.users.create({ display_name: 'Grace', locale: 'fr' });
const workspace = await make.workspaces.create({ owner });
const session = await make.sessions.create({ workspace }); // created by the owner
const member = await make.sessionMembers.create({ session, user: owner, role: 'host' });
```

Defaults: e-mail `<id in lower case>@example.test` (unique), slug `ws-<end of the id>`, platform
`linux`, region `eu`, membership role `member`, session member role `viewer`. Ids come from
`createIdGenerator()` (strictly increasing within the process) unless `ids` is given; timestamps
come from the database unless `clock` is given, then every `created_at`, `updated_at` and
`joined_at` is the clock's time. For the same rows on every run, pass all three:

```ts
const clock = createFakeClock('2026-10-07T12:00:00.000Z');
const random = createSeededRandom('members-test');
const make = createFactories(stack.db, { ids: seededIdGenerator(random, clock), clock, random });
```

## Contract fixtures

`runFixtureSuite` checks fixtures with Ajv (JSON Schema 2020-12) directly, every schema of the
`schemaFile`'s directory loaded so references between them resolve. Two fixture shapes are judged:

- `{schema, valid, data}` (such as `contracts/fixtures/problem/`): `data` must validate exactly
  when `valid` is true;
- event fixtures `{kind, frame, secret_payload}` (`contracts/fixtures/events/`): the frame must
  validate, and the secret payload too where the schema defines `$defs/s_<kind>`.

With `defKey`, the fixture's `data` (or an event's cleartext payload `frame.p`) is checked against
`$defs[defKey(fileName)]` instead. A fixture of another shape, one that is not JSON, or a missing
definition fails its case; nothing passes unjudged.

```ts
import { runFixtureSuite } from '@centcom/testkit';

describe('session events', () => {
  runFixtureSuite({
    fixturesDir: 'contracts/fixtures/events',
    schemaFile: 'contracts/schemas/events.schema.json',
  });
});
```

`events.schema.json` holds the per-kind rules; the fields every frame has are
`envelope.schema.json`'s, which a lane checks with a second suite or `checkFixture`.

## Mock client simulator (B011)

`@centcom/testkit/sim` holds scripted fake clients that speak the relay's WebSocket protocol:
`SimClient`, `SimFleet` (up to 50), the `scenario()` DSL, inbound `faults`, test relay tickets
(`mintTestTicket`, `testJwks`) and `LoopbackRelay`, the in-process server the simulator tests
itself against. The package root exports none of it. See [docs/simulator.md](docs/simulator.md).

## Global setup

`vitest.setup.ts` reaps stale throwaway databases once per run, before any worker starts. A
project whose tests use `startTestStack` adds it to its test options, as `vitest.workspace.ts`
does for this package:

```ts
globalSetup: ['../../packages/testkit/vitest.setup.ts'],
```

## Tests

`test/harness/`: `containers.test.ts` (server choice, the name guard; with servers: cold start
under 20 s, reuse under 2 s, reset, isolation, stop, reaping), `factories.test.ts` (constraints,
distinct e-mails, increasing ids, determinism), `fixtures.test.ts` (every events fixture, a broken
copy failing), `clock-random.test.ts` and `app.test.ts`. The stack tests run in CI on the service
containers (integration job) and on testcontainers (test job), and locally when Docker runs.

`test/sim/` (no servers needed): `handshake`, `heartbeat`, `sequencing`, `resume`, `faults`,
`fleet` (50 clients and the scenario DSL), `ticket`, `fixture-conformance` (every events fixture
sent and echoed) and `exports`.
