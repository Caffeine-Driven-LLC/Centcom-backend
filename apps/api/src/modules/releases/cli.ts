/**
 * `pnpm release:publish <manifest.json> --channel stable|beta|nightly [--dry-run]
 * [--allow-downgrade]` (B084): the release pipeline's way to publish a manifest. It runs with a
 * deploy-time database role (DATABASE_URL); there is no public endpoint for it.
 *
 * - The manifest file is read as bytes and published byte for byte (`ReleasePublisher`): schema,
 *   HTTPS URLs and every artifact's Ed25519 signature against RELEASE_PUBKEYS are checked first.
 * - `--dry-run` checks everything and stores nothing. Without DATABASE_URL it checks the manifest
 *   and signatures only (for a pipeline's signing step); with it, also the version against the
 *   channel.
 * - With REDIS_URL, a stable publish writes `status:min_client_version` and announces the channel
 *   on `releases:inv`; without it (or when Redis fails) the API's sync job and refresh catch up
 *   within 30 s.
 *
 * Prints one JSON line: `{"ok":true,"channel":...,"version":...}` or `{"ok":false,"code":...,
 * "detail":...,"errors":[...]}`. Exit codes: 0 done, 1 refused or failed, 2 usage.
 *
 * Owns: arguments, output and exit codes. Must not: print a credential or a connection string.
 */
import { readFile } from 'node:fs/promises';
import {
  baseEnvSchema,
  createRedis,
  defineConfig,
  isAppError,
  keyPrefixFor,
  secretString,
  z,
  type Env,
  type KeyValue,
  type PubSub,
} from '@centcom/core';
import { closeDb, createDb, type ReleaseDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { loadReleasesConfig } from './config.js';
import { CHANNELS, parseManifest, verifySignatures } from './manifest.js';
import { ReleasePublisher } from './publisher.js';
import { createReleaseRepository } from './repository.js';

/** Exit codes. */
export const PUBLISH_EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

export const PUBLISH_USAGE =
  'usage: pnpm release:publish <manifest.json> --channel stable|beta|nightly [--dry-run] [--allow-downgrade]\n';

/** The CLI's connections, replaceable in tests. */
export interface PublishCliDeps {
  out(text: string): void;
  err(text: string): void;
  env?: Env;
  /** The database for `url`; default `createDb`. */
  connectDb?(url: string): { db: Kysely<ReleaseDatabase>; close(): Promise<void> };
  /** Redis for `url`; default `createRedis`. */
  connectRedis?(
    url: string,
    nodeEnv: string,
  ): { kv: KeyValue; pubsub: PubSub; close(): Promise<void> };
}

/** The arguments. */
interface Args {
  file: string;
  channel: (typeof CHANNELS)[number];
  dryRun: boolean;
  allowDowngrade: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  let file: string | undefined;
  let channel: string | undefined;
  let dryRun = false;
  let allowDowngrade = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--allow-downgrade') allowDowngrade = true;
    else if (arg === '--channel') channel = argv[(i += 1)];
    else if (arg !== undefined && !arg.startsWith('--') && file === undefined) file = arg;
    else return null;
  }
  if (file === undefined || channel === undefined) return null;
  if (!(CHANNELS as readonly string[]).includes(channel)) return null;
  return { file, channel: channel as Args['channel'], dryRun, allowDowngrade };
}

const envSchema = z.object({
  NODE_ENV: baseEnvSchema.shape.NODE_ENV,
  DATABASE_URL: secretString().optional(),
  REDIS_URL: secretString().optional(),
});

/** A refusal as one JSON line: its code, detail and field errors only. */
function describe(err: unknown): Record<string, unknown> {
  if (isAppError(err)) {
    return {
      ok: false,
      code: err.code,
      ...(err.detail === undefined ? {} : { detail: err.detail }),
      ...(err.errors === undefined ? {} : { errors: err.errors }),
    };
  }
  return { ok: false, code: 'internal_error', detail: (err as Error).name };
}

/** Runs the CLI; resolves to its exit code. */
export async function runPublishCli(
  argv: readonly string[],
  deps: PublishCliDeps,
): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    deps.err(PUBLISH_USAGE);
    return PUBLISH_EXIT.usage;
  }
  const closers: (() => Promise<void>)[] = [];
  try {
    const config = loadReleasesConfig(deps.env);
    const env = defineConfig(envSchema, deps.env);
    const text = await readFile(args.file, 'utf8');
    if (env.DATABASE_URL === undefined) {
      if (!args.dryRun) {
        deps.err(
          'release:publish: DATABASE_URL is required to publish (use --dry-run to check only)\n',
        );
        return PUBLISH_EXIT.usage;
      }
      const parsed = parseManifest(text, { artifactHosts: config.artifactHosts });
      if (config.keys.length === 0) throw new Error('NoReleaseKeys');
      verifySignatures(parsed.manifest, config.keys);
      if (parsed.manifest.channel !== args.channel) {
        deps.out(
          `${JSON.stringify({ ok: false, code: 'validation_failed', detail: 'The manifest is for another channel.' })}\n`,
        );
        return PUBLISH_EXIT.failed;
      }
      deps.out(
        `${JSON.stringify({ ok: true, channel: args.channel, version: parsed.manifest.version, dryRun: true, checked: 'manifest and signatures' })}\n`,
      );
      return PUBLISH_EXIT.ok;
    }
    const database =
      deps.connectDb?.(env.DATABASE_URL.reveal()) ??
      (() => {
        const db = createDb<ReleaseDatabase>({
          url: env.DATABASE_URL.reveal(),
          poolMax: 2,
          applicationName: 'release-publish',
        });
        return { db, close: () => closeDb(db) };
      })();
    closers.push(database.close);
    let redis: { kv: KeyValue; pubsub: PubSub } | undefined;
    if (env.REDIS_URL !== undefined && !args.dryRun) {
      const connected =
        deps.connectRedis?.(env.REDIS_URL.reveal(), env.NODE_ENV) ??
        (() => {
          const backend = createRedis({
            url: env.REDIS_URL,
            keyPrefix: keyPrefixFor(env.NODE_ENV),
          });
          return { kv: backend.kv, pubsub: backend.pubsub, close: () => backend.close() };
        })();
      closers.push(connected.close);
      redis = connected;
    }
    const publisher = new ReleasePublisher({
      repository: createReleaseRepository(database.db),
      config,
      ...(redis === undefined ? {} : { kv: redis.kv, pubsub: redis.pubsub }),
    });
    const result = await publisher.publishRelease(
      text,
      { kind: 'system', name: 'release-cli' },
      { channel: args.channel, dryRun: args.dryRun, allowDowngrade: args.allowDowngrade },
    );
    deps.out(`${JSON.stringify({ ok: true, ...result })}\n`);
    return PUBLISH_EXIT.ok;
  } catch (err) {
    deps.out(`${JSON.stringify(describe(err))}\n`);
    return PUBLISH_EXIT.failed;
  } finally {
    for (const close of closers.reverse()) await close().catch(() => undefined);
  }
}
