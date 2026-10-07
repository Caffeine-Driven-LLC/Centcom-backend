/**
 * Fastify app helper (B010): `withApp(build)` builds an app once for a test file (in `beforeAll`),
 * hands it to the tests for `inject()` calls, and closes it afterwards.
 *
 * Owns: the app's lifecycle around a file's tests. Must not: listen on a port (tests use inject).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';

/** The app of a test file. */
export interface AppHandle {
  /** The built, ready app; available inside tests (after `beforeAll`). */
  readonly app: FastifyInstance;
  /** Closes the app; `afterAll` does it too. Idempotent. */
  close(): Promise<void>;
}

/** Builds the app before the file's tests and closes it after them. Call at the top of a file or describe. */
export function withApp(build: () => Promise<FastifyInstance>): AppHandle {
  let app: FastifyInstance | undefined;
  let closing: Promise<void> | undefined;
  const handle: AppHandle = {
    get app(): FastifyInstance {
      if (app === undefined)
        throw new Error('withApp: the app is built in beforeAll; use it inside a test');
      return app;
    },
    close(): Promise<void> {
      closing ??= app === undefined ? Promise.resolve() : app.close().then(() => undefined);
      return closing;
    },
  };
  beforeAll(async () => {
    app = await build();
    await app.ready();
  });
  afterAll(() => handle.close());
  return handle;
}
