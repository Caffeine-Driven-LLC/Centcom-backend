/**
 * Observability containers for tests (B093), started with testcontainers where a container runtime
 * is reachable (`testcontainersRuntime.check()`; in CI, the test job):
 *
 * - `startCollector(configYaml)`: the OpenTelemetry collector (contrib) with a given config; its
 *   output (a `debug` exporter's) is read from the container log;
 * - `startGrafana()`: Grafana with a known admin password, for importing dashboards;
 * - `runPromtool(files, args)`: Prometheus' `promtool` over the given files (`test rules`);
 * - `runAmtool(files, args)` and `startAlertmanager(files)` (B094): Alertmanager's `amtool`, and a
 *   running Alertmanager that can reach ports the test exposes on the host (a webhook stub).
 *
 * Owns: the containers' lifecycles. Must not: reach any service outside the containers.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { GenericContainer, TestContainers, Wait } from 'testcontainers';
import { CONTAINER_LABELS, CONTAINER_STARTUP_TIMEOUT_MS, TestStackError } from './containers.js';

/** The collector build the infra config targets. */
export const OTEL_COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.111.0';
/** Grafana, for the dashboard import check. */
export const GRAFANA_IMAGE = 'grafana/grafana:11.2.0';
/** Prometheus, for `promtool`. */
export const PROMETHEUS_IMAGE = 'prom/prometheus:v2.54.1';
/** Alertmanager and `amtool`, for the alert routing checks (B094). */
export const ALERTMANAGER_IMAGE = 'prom/alertmanager:v0.27.0';
/** The host name under which a container reaches ports exposed with `hostPorts`. */
export const HOST_FROM_CONTAINER = 'host.testcontainers.internal';

/** Collects a container's log lines. */
function logBuffer(): { consumer: (stream: NodeJS.ReadableStream) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    consumer: (stream) => {
      stream.pipe(
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(String(chunk));
            callback();
          },
        }),
      );
    },
    text: () => chunks.join(''),
  };
}

/** A running collector. */
export interface TestCollector {
  /** OTLP/HTTP base URL (`http://<host>:<port>`). */
  otlpUrl: string;
  /** Everything the collector logged so far (a `debug` exporter's output included). */
  logs(): string;
  stop(): Promise<void>;
}

/** Starts the collector with `configYaml`; it must enable the `health_check` extension on 13133. */
export async function startCollector(configYaml: string): Promise<TestCollector> {
  const logs = logBuffer();
  try {
    const container = await new GenericContainer(OTEL_COLLECTOR_IMAGE)
      .withCopyContentToContainer([
        { content: configYaml, target: '/etc/otelcol-contrib/config.yaml' },
      ])
      .withCommand(['--config=/etc/otelcol-contrib/config.yaml'])
      .withExposedPorts(4318, 13133)
      .withLabels({ ...CONTAINER_LABELS })
      .withLogConsumer(logs.consumer)
      .withWaitStrategy(Wait.forHttp('/', 13133).forStatusCode(200))
      .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
      .start();
    return {
      otlpUrl: `http://${container.getHost()}:${container.getMappedPort(4318)}`,
      logs: logs.text,
      stop: async () => void (await container.stop()),
    };
  } catch (err) {
    throw new TestStackError(`The collector did not start. Its log:\n${logs.text() || '(none)'}`, {
      cause: err,
    });
  }
}

/** A running Grafana. */
export interface TestGrafana {
  url: string;
  /** `Basic …` for the admin user. */
  authorization: string;
  stop(): Promise<void>;
}

/** Starts Grafana with a random admin password. */
export async function startGrafana(): Promise<TestGrafana> {
  const password = randomBytes(12).toString('hex');
  const logs = logBuffer();
  try {
    const container = await new GenericContainer(GRAFANA_IMAGE)
      .withEnvironment({
        GF_SECURITY_ADMIN_PASSWORD: password,
        GF_ANALYTICS_REPORTING_ENABLED: 'false',
        GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
        GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
        GF_NEWS_NEWS_FEED_ENABLED: 'false',
      })
      .withExposedPorts(3000)
      .withLabels({ ...CONTAINER_LABELS })
      .withLogConsumer(logs.consumer)
      .withWaitStrategy(Wait.forHttp('/api/health', 3000).forStatusCode(200))
      .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS * 2)
      .start();
    return {
      url: `http://${container.getHost()}:${container.getMappedPort(3000)}`,
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
      stop: async () => void (await container.stop()),
    };
  } catch (err) {
    throw new TestStackError(`Grafana did not start. Its log:\n${logs.text() || '(none)'}`, {
      cause: err,
    });
  }
}

/** Runs `promtool <args>` with `files` (name to content) in /work; resolves its exit code and output. */
export async function runPromtool(
  files: Readonly<Record<string, string>>,
  args: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const logs = logBuffer();
  try {
    await new GenericContainer(PROMETHEUS_IMAGE)
      .withCopyContentToContainer(
        Object.entries(files).map(([name, content]) => ({ content, target: `/work/${name}` })),
      )
      .withWorkingDir('/work')
      .withEntrypoint(['/bin/promtool'])
      .withCommand([...args])
      .withLabels({ ...CONTAINER_LABELS })
      .withLogConsumer(logs.consumer)
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
      .start();
    return { exitCode: 0, output: logs.text() };
  } catch {
    return { exitCode: 1, output: logs.text() };
  }
}

/** Runs `amtool <args>` with `files` (name to content) in /work; resolves its exit code and output. */
export async function runAmtool(
  files: Readonly<Record<string, string>>,
  args: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const logs = logBuffer();
  try {
    await new GenericContainer(ALERTMANAGER_IMAGE)
      .withCopyContentToContainer(
        Object.entries(files).map(([name, content]) => ({ content, target: `/work/${name}` })),
      )
      .withWorkingDir('/work')
      .withEntrypoint(['/bin/amtool'])
      .withCommand([...args])
      .withLabels({ ...CONTAINER_LABELS })
      .withLogConsumer(logs.consumer)
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
      .start();
    return { exitCode: 0, output: logs.text() };
  } catch {
    return { exitCode: 1, output: logs.text() };
  }
}

/** A running Alertmanager. */
export interface TestAlertmanager {
  /** Its API base URL (`http://<host>:<port>`). */
  url: string;
  /** Everything it logged so far (debug level). */
  logs(): string;
  stop(): Promise<void>;
}

/**
 * Starts Alertmanager with `files` (name to content) in /etc/alertmanager, `alertmanager.yml`
 * among them, clustering off so notifications are not held until gossip settles. `hostPorts` are
 * exposed first: the container reaches them at {@link HOST_FROM_CONTAINER}.
 */
export async function startAlertmanager(
  files: Readonly<Record<string, string>>,
  options: { hostPorts?: readonly number[] } = {},
): Promise<TestAlertmanager> {
  const logs = logBuffer();
  try {
    if (options.hostPorts !== undefined && options.hostPorts.length > 0) {
      await TestContainers.exposeHostPorts(...options.hostPorts);
    }
    const container = await new GenericContainer(ALERTMANAGER_IMAGE)
      .withCopyContentToContainer(
        Object.entries(files).map(([name, content]) => ({
          content,
          target: `/etc/alertmanager/${name}`,
        })),
      )
      .withCommand([
        '--config.file=/etc/alertmanager/alertmanager.yml',
        '--storage.path=/alertmanager',
        '--cluster.listen-address=',
        '--log.level=debug',
      ])
      .withExposedPorts(9093)
      .withLabels({ ...CONTAINER_LABELS })
      .withLogConsumer(logs.consumer)
      .withWaitStrategy(Wait.forHttp('/-/ready', 9093).forStatusCode(200))
      .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
      .start();
    return {
      url: `http://${container.getHost()}:${container.getMappedPort(9093)}`,
      logs: logs.text,
      stop: async () => void (await container.stop()),
    };
  } catch (err) {
    throw new TestStackError(`Alertmanager did not start. Its log:\n${logs.text() || '(none)'}`, {
      cause: err,
    });
  }
}
