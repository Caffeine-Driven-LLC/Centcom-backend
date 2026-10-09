# @centcom/relay

The WebSocket relay (CT-WS-ENVELOPE): sessions, sequencing, queue, presence and control, routing
ciphertext only. Today it is the service skeleton (B037): the server, health endpoints,
configuration, metrics, the module loader and frame pipeline that relay lanes plug into, the
connection registry, close codes and graceful shutdown. Lanes B038 to B050 add the protocol as
modules.

```sh
node dist/main.js   # after pnpm build; reads the environment below and B004's base keys
```

## Endpoints

| Path           | What it answers                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz` | `200 {"status":"ok"}` while the process runs. Never touches a dependency.                                                                               |
| `GET /readyz`  | `200 {"status":"ok","checks":{…}}` when Redis, Postgres and its migrations are fine; else, and while draining, `503 {"status":"degraded","checks":{…}}` |
| `/v1/ws`       | WebSocket upgrade, subprotocol `centcom.v1` only                                                                                                        |

Upgrades are refused with an HTTP status before any WebSocket exists:

| Refusal                                                               | Status |
| --------------------------------------------------------------------- | ------ |
| any path but `/v1/ws`                                                 | 404    |
| a `ticket` or `token` query parameter (credentials go in `sys.hello`) | 400    |
| shutting down                                                         | 503    |
| a browser `Origin` not in `RELAY_ALLOWED_ORIGINS`                     | 403    |
| no `centcom.v1` among the offered subprotocols                        | 400    |

An accepted connection past `RELAY_MAX_CONNECTIONS`, or while a dependency is down, receives a
`sys.error` (503, `retry_after_s: 5`) and is closed 4503 at once. A message larger than
`RELAY_MAX_TRANSPORT_BYTES` closes its connection with 1009 before it is buffered (the 256 KiB
frame rule is B039's).

## Configuration

Besides B004's base keys (`NODE_ENV`, `SERVICE_NAME`, `LOG_LEVEL`, `HOST`, `DATABASE_URL`,
`REDIS_URL`, …; [docs/config.md](../../docs/config.md)):

| Key                         | Default   | What it is                                                                    |
| --------------------------- | --------- | ----------------------------------------------------------------------------- |
| `RELAY_PORT`                | `8080`    | Port of the health endpoints and `/v1/ws`                                     |
| `RELAY_REGION`              | `local`   | Region served (logs)                                                          |
| `RELAY_MAX_CONNECTIONS`     | `20000`   | Connections held; one more gets 4503                                          |
| `RELAY_SHUTDOWN_DRAIN_MS`   | `25000`   | Longest wait for connections to close on SIGTERM before they are cut (1 s up) |
| `RELAY_MAX_TRANSPORT_BYTES` | `1048576` | Largest WebSocket message buffered (256 KiB to 16 MiB)                        |
| `RELAY_ALLOWED_ORIGINS`     | empty     | Comma-separated browser origins; empty: only clients sending no `Origin`      |

## Modules

A relay lane adds a folder under `src/` whose `module.ts` default-exports a `RelayModule`:

```ts
import { STAGE_ORDER, type RelayModule } from '../index.js';

const handshake: RelayModule = {
  name: 'handshake',
  order: 15,
  register(ctx) {
    ctx.pipeline.use(STAGE_ORDER.handshake, async (fc, next) => {
      // …check fc.frame, then:
      await next();
    });
    ctx.onConnection((connection) => {
      /* start the handshake timer */
    });
    ctx.onShutdown(async () => {
      /* flush */
    });
    return undefined;
  },
};
export default handshake;
```

At startup every `src/<folder>/module.(ts|js)` is loaded and registered once, by `order` then
name. A module that fails to load or register stops the startup (exit 1, `relay.start_failed`
naming it). Stage orders are reserved: activity 5, decode 10, heartbeat 12, handshake 15,
authorise 20, privacy 30, sequence 40, fan-out 50. The `RelayContext` carries the configuration,
logger, metrics, clock, Redis, the database, the connection registry, the pipeline, and
`onShutdown` / `onConnection`. Nothing is global. A connection's `onClose(listener)` runs once its
socket has closed, whoever closed it. A stage or handler that throws closes its connection with a
`sys.error` and 1011 (`relay_handler_errors_total`); the process stays up.

Every close goes through `closeConnection(connection, spec)` (B040,
[src/connection/README.md](src/connection/README.md)): it sends the `sys.error` or `sys.bye` the
close code requires, closes once, and cuts a socket that has not closed 1 s later.

Modules today: the codec (B039, order 10), the connection state machine and heartbeat (B040, 12),
the handshake (B038, 15), the rooms (B043, 20), presence (B047, 35;
[src/presence/README.md](src/presence/README.md), it sets `ctx.presence`), cursors and typing
(B048, 36; [src/cursors/README.md](src/cursors/README.md)), sequencing (B041, 40; it sets `ctx.seq` for the
modules after it), resume (B042, 45; [src/resume/README.md](src/resume/README.md), it sets
`ctx.resume` for the handshake), fan-out (B044, 50; it sets `ctx.fanout`), backpressure (B046, 55;
[src/backpressure/README.md](src/backpressure/README.md), it sets `ctx.backpressure` and adds the
`buffers` readiness check) and the cluster (B045,
60; [src/cluster/README.md](src/cluster/README.md), it sets `ctx.cluster`).

## Shutdown

On SIGTERM or SIGINT, `/readyz` turns 503 and upgrades get 503. Every connection is then sent
`sys.bye` (`reason: "server_restart"`) and closed 1001, at a random moment within 5 s so clients
do not reconnect all at once. When all are gone, or at `RELAY_SHUTDOWN_DRAIN_MS` (those left are
cut and `shutdown.forced` logs their count), the modules' shutdown steps run and the process exits 0.
A signal during startup exits 0 without serving; a port in use exits 1 (`relay.port_in_use`).

## Metrics and logs

- `relay_connections` (a gauge read from `RelayServer.gauges()` at each export),
  `relay_connections_total`, `relay_frames_total{t,direction}` (the envelope type, `invalid` or
  `binary`; `in`), `relay_close_total{code}` (a known code or `other`),
  `relay_handler_errors_total`, `relay_upgrades_refused_total{reason}`. No label holds a session,
  member or user id. They are exported as `centcom_*` through B093's telemetry (`main.ts` wires it),
  with one span per connection (`relay.connection`, its close code) and none per frame.
- Logs: `relay.starting` and `relay.started` (with `version` and `contract_version`),
  `relay.upgrade_refused` (reason and status only), `relay.handler_error`, `shutdown.*`. The query
  string, the subprotocol header and credentials are never logged. Remote addresses are kept only
  as a keyed hash (`ConnectionRegistry`).

## Tests

`test/`:

- **`relay.health.test.ts`:** liveness without dependencies, the readiness matrix (Redis, database,
  migrations, draining, a hanging dependency), and the real probe on Postgres and Redis (CI).
- **`relay.upgrade.test.ts`:** subprotocols, paths, credentials in the query, origins, the
  transport guard, and the close-code table against the contract.
- **`relay.capacity.test.ts`:** the cap and 4503, refusals while not ready, the registry, failing
  handlers.
- **`relay.modules.test.ts`:** registration order and failure, discovery, the context, the
  pipeline.
- **`relay.shutdown.test.ts`:** 200 connections drained with jittered 1001, the forced stop,
  shutdown steps, signals.
- **`relay.metrics.test.ts`:** names and label values over 100 connections.
- **`relay.main.test.ts`:** the process itself: startup with dependencies down, the version log,
  SIGTERM, a port in use, a signal during startup, bad configuration.
- **`codec/`, `handshake/`, `connection/`:** each module's tests (see its README).
