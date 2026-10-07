/**
 * Test helpers for @centcom/db (B007): fixture directories, scratch copies of them, ports where
 * nothing answers, and throwaway databases on the Postgres that DATABASE_URL points at.
 *
 * Real-Postgres tests run only when DATABASE_URL is set: in CI's `integration` job (Postgres 16
 * service container) or locally against a server where the user may CREATE DATABASE. Every such
 * test gets a database of its own, dropped afterwards, so test files can run in parallel.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, z } from '@centcom/core';
import pg from 'pg';

/** Directories of sample migrations under test/runner/fixtures. */
export const FIXTURES = {
  sample: join(import.meta.dirname, 'fixtures', 'sample'),
  failing: join(import.meta.dirname, 'fixtures', 'failing'),
  slow: join(import.meta.dirname, 'fixtures', 'slow'),
} as const;

/** Versions of the sample migrations, in order. */
export const SAMPLE_VERSIONS = ['20260101000000', '20260101000100', '20260101000200'] as const;

/** The Postgres to create throwaway databases on, or undefined to skip the real-Postgres tests. */
export const ADMIN_URL: string | undefined = defineConfig(
  z.object({ DATABASE_URL: z.string().optional() }),
).DATABASE_URL;

/** A scratch copy of a fixture directory (or an empty one), removed by the returned function. */
export async function scratchDir(
  from?: string,
): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'centcom-db-'));
  if (from !== undefined) await cp(from, dir, { recursive: true });
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A new empty database; `drop` removes it, closing any session still on it. */
export async function tempDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (ADMIN_URL === undefined) throw new Error('tempDatabase needs DATABASE_URL');
  const name = `centcom_t_${randomBytes(6).toString('hex')}`;
  // Database names cannot be parameters; this one is ours, and quoted besides.
  await admin((c) => c.query(`create database ${pg.escapeIdentifier(name)}`));
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () =>
      admin((c) =>
        c.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`),
      ).then(() => undefined),
  };
}

/** Runs `fn` with a client on database `url`, for setting up or inspecting state behind the package's back. */
export async function onDatabase<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A localhost port nothing listens on (a server is bound, then closed). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, 'close');
  return port;
}

/** A server that accepts connections and never answers, to make a client wait. */
export async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    url: `postgres://centcom:unused@127.0.0.1:${port}/centcom`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
