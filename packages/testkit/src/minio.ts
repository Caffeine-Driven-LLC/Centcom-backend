/**
 * An S3-compatible object store for tests (B082): a MinIO container started with testcontainers,
 * the same build as the development stack (infra/compose), with throwaway credentials. Tests that
 * need it run where a container runtime is reachable (`testcontainersRuntime.check()`), which in CI
 * is both the test and the integration job.
 *
 * The container starts with no buckets: create them over S3 (MinIO accepts a signed `PUT /<bucket>`).
 *
 * Owns: the container's lifecycle. Must not: reuse credentials across runs.
 */
import { randomBytes } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import { CONTAINER_LABELS, CONTAINER_STARTUP_TIMEOUT_MS, TestStackError } from './containers.js';

/** Bitnami's frozen build of MinIO's 2025-07-23 release, as infra/compose runs. */
export const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';
/** MinIO's S3 port inside the container. */
const S3_PORT = 9000;

/** A running MinIO. */
export interface TestMinio {
  /** `http://<host>:<port>`, no trailing slash. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  stop(): Promise<void>;
}

/** Starts MinIO; rejects with a TestStackError when it does not come up in time. */
export async function startMinio(): Promise<TestMinio> {
  const accessKeyId = `test${randomBytes(6).toString('hex')}`;
  const secretAccessKey = randomBytes(18).toString('hex');
  try {
    const container = await new GenericContainer(MINIO_IMAGE)
      .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
      .withExposedPorts(S3_PORT)
      .withLabels({ ...CONTAINER_LABELS })
      .withWaitStrategy(Wait.forHttp('/minio/health/live', S3_PORT).forStatusCode(200))
      .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
      .start();
    return {
      endpoint: `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`,
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      stop: async () => void (await container.stop()),
    };
  } catch (err) {
    throw new TestStackError(
      `The MinIO container did not start within ${CONTAINER_STARTUP_TIMEOUT_MS / 1000} s.`,
      { cause: err },
    );
  }
}
