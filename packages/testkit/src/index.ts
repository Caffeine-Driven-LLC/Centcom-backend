/**
 * @centcom/testkit (B010): the backend's test harness. A migrated Postgres database and a Redis
 * namespace per test file (`startTestStack`, on CI's services or on containers), a MinIO object
 * store (`startMinio`, B082), observability containers (collector, Grafana, promtool; B093), factories for the core schema, a fake clock and seeded randomness,
 * the contract fixture runner and a Fastify app helper. Test-only: other packages list it as a
 * devDependency, and production code never imports it.
 */
export { createFakeClock, DEFAULT_FAKE_TIME, type FakeClock } from './clock.js';
export { createSeededRandom, seededIdGenerator, type SeededRandom } from './random.js';
export {
  assertTestDatabaseName,
  CONTAINER_LABELS,
  CONTAINER_STARTUP_TIMEOUT_MS,
  POSTGRES_IMAGE,
  reapStaleTestDatabases,
  REDIS_IMAGE,
  resolveTestServers,
  STALE_DATABASE_MS,
  startTestStack,
  testcontainersRuntime,
  TestStackError,
  type ContainerRuntime,
  type TestServers,
  type TestStack,
  type TestStackOptions,
} from './containers.js';
export {
  createFactories,
  deviceFactory,
  membershipFactory,
  sessionFactory,
  sessionMemberFactory,
  userFactory,
  workspaceFactory,
  type DeviceFactory,
  type FactoryDeps,
  type MembershipFactory,
  type Ref,
  type SessionFactory,
  type SessionMemberFactory,
  type UserFactory,
  type WorkspaceFactory,
} from './factories/index.js';
export {
  checkFixture,
  runFixtureSuite,
  type FixtureResult,
  type FixtureSuiteOptions,
} from './fixtures.js';
export { withApp, type AppHandle } from './app.js';
export { MINIO_IMAGE, startMinio, type TestMinio } from './minio.js';
export {
  GRAFANA_IMAGE,
  OTEL_COLLECTOR_IMAGE,
  PROMETHEUS_IMAGE,
  runPromtool,
  startCollector,
  startGrafana,
  type TestCollector,
  type TestGrafana,
} from './observability.js';
