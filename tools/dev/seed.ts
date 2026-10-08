/**
 * Dev seed (B012): fixed data for the local stack, so docs, scripts and manual tests can name rows
 * by id. Three users (owner, member, guest), the workspace `acme-dev` with one membership per user
 * in that workspace role, two devices with fixed test keys, and one paused session.
 *
 *   pnpm dev:seed    seeds DATABASE_URL (the environment's, else .env.local's); `pnpm dev:up` runs it
 *
 * Every row is inserted with ON CONFLICT (id) DO NOTHING, all in one transaction: a second run adds
 * nothing, and a run that fails midway leaves nothing behind.
 *
 * The device keys are test-only. Their private halves come from public labels
 * (`seedDevicePrivateKey`), so anyone can derive them; they must never be trusted outside a dev
 * stack, and `SEED_TEST_PUBLIC_KEYS` lists them for code that rejects them there.
 *
 * Owns: the seed constants and the guard on where they may be written. Must not: run with
 * NODE_ENV=production, or against a database not named `centcom_dev` or `test_*`.
 */
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig, z } from '@centcom/core';
import { closeDb, createDb, type CoreDatabase } from '@centcom/db';

/** When every seeded row was created; the ids' ULID time is the same moment. */
export const SEED_CREATED_AT = '2026-01-01T00:00:00.000Z';

/** Fixed ids: ULID time 2026-01-01T00:00Z, then `DEVSEED` and a counter, so they read as seed data. */
const id = <P extends string>(prefix: P, n: number) =>
  `${prefix}_01KDVDNA00DEVSEED${String(n).padStart(9, '0')}` as const;

/** The seeded rows. Ids never change, so docs and tests may quote them. */
export const SEED = deepFreeze({
  users: {
    owner: { id: id('usr', 1), email: 'owner@acme-dev.test', displayName: 'Olive Owner' },
    member: { id: id('usr', 2), email: 'member@acme-dev.test', displayName: 'Max Member' },
    guest: { id: id('usr', 3), email: 'guest@acme-dev.test', displayName: 'Gil Guest' },
  },
  workspace: { id: id('wsp', 1), name: 'Acme Dev', slug: 'acme-dev', createdBy: 'owner' },
  memberships: {
    owner: { id: id('mem', 1), user: 'owner', role: 'owner' },
    member: { id: id('mem', 2), user: 'member', role: 'member' },
    guest: { id: id('mem', 3), user: 'guest', role: 'guest' },
  },
  devices: {
    // Public keys and fingerprints as derived from seedDevicePrivateKey; seed.test.ts re-derives them.
    ownerLaptop: {
      id: id('dev', 1),
      user: 'owner',
      name: 'owner-laptop',
      platform: 'linux',
      x25519Pub: 'rjNaDJZfZXgceCLpPpS3VR_m0l_UiNOOy12xIODtYAs',
      ed25519Pub: '4DM5_5Js4_6-ROaQJH1o-27jm1D3byA5kxzcC4YOUts',
      fingerprint: '3OE7-23IB-PN3N',
    },
    memberDesktop: {
      id: id('dev', 2),
      user: 'member',
      name: 'member-desktop',
      platform: 'macos',
      x25519Pub: 'FhjOgOBRLpqZWkjIkDyRyQjsqHb8R5rupyESVf01oVo',
      ed25519Pub: '3h52evDDAdlgLTkxGYg6sfOD8oslNEMm2MTiV-n2hRk',
      fingerprint: 'IJIC-IOIW-BMYN',
    },
  },
  session: {
    id: id('ses', 1),
    name: 'Paused demo session',
    state: 'paused',
    region: 'eu',
    createdBy: 'owner',
  },
} as const);

export type SeedUser = keyof typeof SEED.users;
export type SeedDevice = keyof typeof SEED.devices;
export type DeviceKeyKind = 'x25519' | 'ed25519';

/** Every seeded public key: valid only on a dev stack. */
export const SEED_TEST_PUBLIC_KEYS: readonly string[] = Object.freeze(
  Object.values(SEED.devices).flatMap((d) => [d.x25519Pub, d.ed25519Pub]),
);

/** PKCS#8 DER header of a raw 32-byte private key (RFC 8410). */
const PKCS8_PREFIX: Record<DeviceKeyKind, string> = {
  x25519: '302e020100300506032b656e04220420',
  ed25519: '302e020100300506032b657004220420',
};

/**
 * The private half of a seeded device key, for scripts that act as that device. It is the SHA-256
 * of a public label, so it is test-only by construction.
 */
export function seedDevicePrivateKey(device: SeedDevice, kind: DeviceKeyKind): KeyObject {
  const raw = createHash('sha256')
    .update(`centcom dev-only test key/${SEED.devices[device].name}/${kind}`)
    .digest();
  return createPrivateKey({
    key: Buffer.concat([Buffer.from(PKCS8_PREFIX[kind], 'hex'), raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Why the seed refused to run. */
export class SeedRefusedError extends Error {}
Object.defineProperty(SeedRefusedError.prototype, 'name', {
  value: 'SeedRefusedError',
  writable: true,
  configurable: true,
});

/** The only databases the seed writes to: the dev stack's, and the test harness's (B010). */
const SEEDABLE_DATABASE = /^(centcom_dev|test_[a-z0-9_]+)$/;

/** Throws SeedRefusedError unless the seed may write to `databaseUrl`. Never prints the URL. */
export function assertSeedTarget(databaseUrl: string, nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new SeedRefusedError('refusing to seed with NODE_ENV=production');
  }
  let name: string;
  try {
    const url = new URL(databaseUrl);
    // Anything else could put a password where the database name is read, and into the error.
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new TypeError();
    name = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new SeedRefusedError('DATABASE_URL is not a valid postgres:// URL');
  }
  if (!SEEDABLE_DATABASE.test(name)) {
    throw new SeedRefusedError(
      `refusing to seed database ${JSON.stringify(name)}: only centcom_dev or test_* databases`,
    );
  }
}

/** Rows each table gained in one run. */
export interface SeedResult {
  users: number;
  workspaces: number;
  memberships: number;
  devices: number;
  sessions: number;
}

type Db = ReturnType<typeof createDb<CoreDatabase>>;

/** Writes the seed rows that are missing, in one transaction. Returns how many each table gained. */
export async function seed(db: Db): Promise<SeedResult> {
  const at = SEED_CREATED_AT;
  const userId = (user: SeedUser) => SEED.users[user].id;
  return db.transaction().execute(async (trx) => {
    const count = (r: { numInsertedOrUpdatedRows?: bigint }) => Number(r.numInsertedOrUpdatedRows);
    const users = await trx
      .insertInto('users')
      .values(
        Object.values(SEED.users).map((u) => ({
          id: u.id,
          email: u.email,
          display_name: u.displayName,
          created_at: at,
          updated_at: at,
        })),
      )
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirstOrThrow();
    const workspaces = await trx
      .insertInto('workspaces')
      .values({
        id: SEED.workspace.id,
        name: SEED.workspace.name,
        slug: SEED.workspace.slug,
        created_by: userId(SEED.workspace.createdBy),
        created_at: at,
        updated_at: at,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirstOrThrow();
    const memberships = await trx
      .insertInto('memberships')
      .values(
        Object.values(SEED.memberships).map((m) => ({
          id: m.id,
          workspace_id: SEED.workspace.id,
          user_id: userId(m.user),
          role: m.role,
          created_at: at,
        })),
      )
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirstOrThrow();
    const devices = await trx
      .insertInto('devices')
      .values(
        Object.values(SEED.devices).map((d) => ({
          id: d.id,
          user_id: userId(d.user),
          name: d.name,
          platform: d.platform,
          x25519_pub: d.x25519Pub,
          ed25519_pub: d.ed25519Pub,
          fingerprint: d.fingerprint,
          created_at: at,
        })),
      )
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirstOrThrow();
    const sessions = await trx
      .insertInto('sessions')
      .values({
        id: SEED.session.id,
        workspace_id: SEED.workspace.id,
        name: SEED.session.name,
        state: SEED.session.state,
        region: SEED.session.region,
        created_by: userId(SEED.session.createdBy),
        created_at: at,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirstOrThrow();
    return {
      users: count(users),
      workspaces: count(workspaces),
      memberships: count(memberships),
      devices: count(devices),
      sessions: count(sessions),
    };
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const ROOT = join(import.meta.dirname, '..', '..');

const seedEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string().min(1),
});

/** `pnpm dev:seed`: seeds DATABASE_URL. Returns the exit code. */
export async function main(): Promise<number> {
  // The environment wins over .env.local (process.loadEnvFile keeps variables already set).
  const envFile = join(ROOT, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  let url: string;
  try {
    const env = defineConfig(seedEnvSchema);
    assertSeedTarget(env.DATABASE_URL, env.NODE_ENV);
    url = env.DATABASE_URL;
  } catch (err) {
    console.error(`dev:seed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const db = createDb<CoreDatabase>({ url, poolMax: 1, applicationName: 'centcom-dev-seed' });
  try {
    const added = await seed(db);
    const total = Object.values(added).reduce((a, b) => a + b, 0);
    console.log(
      total === 0
        ? 'dev:seed: the seed data is already there; nothing to add.'
        : `dev:seed: rows added: ${Object.entries(added)
            .map(([table, n]) => `${table} ${n}`)
            .join(', ')}.`,
    );
    return 0;
  } catch (err) {
    console.error(
      `dev:seed: failed, nothing was written (${err instanceof Error ? err.message : String(err)})`,
    );
    return 1;
  } finally {
    await closeDb(db).catch(() => undefined);
  }
}

/** True when this file is the process's entry script (tsx tools/dev/seed.ts). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
