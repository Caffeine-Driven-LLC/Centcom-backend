/**
 * Dev seed (B012): where it may write, its fixed ids and test-only device keys, and, on a real
 * stack (B010), that two runs leave exactly the seeded rows (acceptance 2 and 3) and that a run
 * failing midway writes nothing.
 *
 * The stack tests run where the testkit can start one: DATABASE_URL and REDIS_URL set (CI's
 * integration job, or the dev stack itself), or a container runtime (CI's test job).
 */
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { isId, newId } from '@centcom/contracts';
import { defineConfig, z } from '@centcom/core';
import { currentMigrationVersion, expectedMigrationVersion } from '@centcom/db';
import { startTestStack, testcontainersRuntime, type TestStack } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSeedTarget,
  seed,
  SEED,
  SEED_CREATED_AT,
  SEED_TEST_PUBLIC_KEYS,
  seedDevicePrivateKey,
  SeedRefusedError,
  type DeviceKeyKind,
} from './seed.js';

const env = defineConfig(
  z.object({ DATABASE_URL: z.string().optional(), REDIS_URL: z.string().optional() }),
);
const STACK =
  (env.DATABASE_URL !== undefined && env.REDIS_URL !== undefined) ||
  (await testcontainersRuntime.check().then(
    () => true,
    () => false,
  ));
const STACK_TIMEOUT_MS = 180_000;

/** CT-CRYPTO §1 needs BLAKE2b-256, which Node lacks; Python's hashlib has it. */
const PYTHON_FINGERPRINT = `
import base64, hashlib, sys
raw = lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
fp = base64.b32encode(hashlib.blake2b(raw(sys.argv[1]) + raw(sys.argv[2]), digest_size=32).digest()).decode()[:12]
print(fp[0:4] + '-' + fp[4:8] + '-' + fp[8:12])
`;
const PYTHON = spawnSync('python3', ['-c', 'import hashlib; hashlib.blake2b'], { stdio: 'ignore' });
const HAS_PYTHON = PYTHON.status === 0;

const url = (name: string) => `postgres://centcom:dev-only@127.0.0.1:5432/${name}`;

describe('where the seed may write', () => {
  it('refuses NODE_ENV=production, whatever the database', () => {
    expect(() => assertSeedTarget(url('centcom_dev'), 'production')).toThrow(SeedRefusedError);
    expect(() => assertSeedTarget(url('centcom_dev'), 'production')).toThrow(/NODE_ENV=production/);
  });

  it.each(['centcom', 'centcom_dev2', 'postgres', 'prod_centcom_dev', 'test', 'Test_1', ''])(
    'refuses the database %j',
    (name) => {
      expect(() => assertSeedTarget(url(name), 'development')).toThrow(
        /only centcom_dev or test_\* databases/,
      );
    },
  );

  it.each(['centcom:dev-only@nowhere', 'not a url', 'mysql://u:dev-only@host/centcom_dev'])(
    'refuses the DATABASE_URL %j without echoing any of it',
    (value) => {
      let message = '';
      try {
        assertSeedTarget(value, undefined);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe('DATABASE_URL is not a valid postgres:// URL');
    },
  );

  it.each(['centcom_dev', 'test_1791380000_0a1b2c3d'])('accepts %j', (name) => {
    expect(() => assertSeedTarget(url(name), 'development')).not.toThrow();
    expect(() => assertSeedTarget(url(name), undefined)).not.toThrow();
  });
});

describe('the seed data', () => {
  it('has fixed CT-IDS ids that docs can quote', () => {
    expect(SEED.users.owner.id).toBe('usr_01KDVDNA00DEVSEED000000001');
    expect(SEED.workspace.id).toBe('wsp_01KDVDNA00DEVSEED000000001');
    type Prefix = Parameters<typeof isId>[0];
    const ids: [Prefix, string][] = [
      ...Object.values(SEED.users).map((u): [Prefix, string] => ['usr', u.id]),
      ['wsp', SEED.workspace.id],
      ...Object.values(SEED.memberships).map((m): [Prefix, string] => ['mem', m.id]),
      ...Object.values(SEED.devices).map((d): [Prefix, string] => ['dev', d.id]),
      ['ses', SEED.session.id],
    ];
    for (const [prefix, id] of ids) expect(isId(prefix, id), id).toBe(true);
    expect(new Set(ids.map(([, id]) => id)).size).toBe(ids.length);
  });

  it('is three users with the roles owner, member and guest in acme-dev, two devices and a paused session', () => {
    expect(Object.keys(SEED.users)).toHaveLength(3);
    expect(Object.values(SEED.memberships).map((m) => m.role)).toEqual([
      'owner',
      'member',
      'guest',
    ]);
    expect(SEED.workspace.slug).toBe('acme-dev');
    expect(Object.keys(SEED.devices)).toHaveLength(2);
    expect(SEED.session.state).toBe('paused');
    for (const user of Object.values(SEED.users)) expect(user.email).toMatch(/@acme-dev\.test$/);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(SEED)).toBe(true);
    expect(Object.isFrozen(SEED.devices.ownerLaptop)).toBe(true);
    expect(Object.isFrozen(SEED_TEST_PUBLIC_KEYS)).toBe(true);
  });

  it('has device public keys that come from the documented test-only private keys (acceptance 6)', () => {
    for (const [name, device] of Object.entries(SEED.devices)) {
      const keys: Record<DeviceKeyKind, string> = {
        x25519: device.x25519Pub,
        ed25519: device.ed25519Pub,
      };
      for (const [kind, pub] of Object.entries(keys) as [DeviceKeyKind, string][]) {
        const priv = seedDevicePrivateKey(name as keyof typeof SEED.devices, kind);
        expect(priv.asymmetricKeyType).toBe(kind);
        expect(createPublicKey(priv).export({ format: 'jwk' }).x, `${name} ${kind}`).toBe(pub);
        expect(pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
      }
    }
    expect(new Set(SEED_TEST_PUBLIC_KEYS).size).toBe(4);
  });

  it('has fingerprints in the shown form ABCD-EFGH-IJKL', () => {
    for (const device of Object.values(SEED.devices)) {
      expect(device.fingerprint).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });

  it.runIf(HAS_PYTHON)(
    'has fingerprints derived as CT-CRYPTO §1 says (BLAKE2b-256, via python3)',
    () => {
      for (const device of Object.values(SEED.devices)) {
        const run = spawnSync(
          'python3',
          ['-c', PYTHON_FINGERPRINT, device.x25519Pub, device.ed25519Pub],
          {
            encoding: 'utf8',
          },
        );
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout.trim()).toBe(device.fingerprint);
      }
    },
  );
});

describe.runIf(STACK)('seeding a real database', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  const counts = async () => {
    const n = async (table: 'users' | 'workspaces' | 'memberships' | 'devices' | 'sessions') =>
      Number(
        (
          await stack.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    return {
      users: await n('users'),
      workspaces: await n('workspaces'),
      memberships: await n('memberships'),
      devices: await n('devices'),
      sessions: await n('sessions'),
    };
  };

  it('writes the seeded rows once; a second run adds nothing (acceptance 2 and 3)', async () => {
    assertSeedTarget(stack.databaseUrl, 'test');
    expect(await currentMigrationVersion(stack.db)).toBe(expectedMigrationVersion());

    expect(await seed(stack.db)).toEqual({
      users: 3,
      workspaces: 1,
      memberships: 3,
      devices: 2,
      sessions: 1,
    });
    const first = await counts();
    expect(await seed(stack.db)).toEqual({
      users: 0,
      workspaces: 0,
      memberships: 0,
      devices: 0,
      sessions: 0,
    });
    expect(await counts()).toEqual(first);
    expect(first).toEqual({ users: 3, workspaces: 1, memberships: 3, devices: 2, sessions: 1 });

    const roles = await stack.db
      .selectFrom('memberships')
      .select(['role', 'user_id', 'workspace_id'])
      .orderBy('role')
      .execute();
    expect(roles).toEqual([
      { role: 'guest', user_id: SEED.users.guest.id, workspace_id: SEED.workspace.id },
      { role: 'member', user_id: SEED.users.member.id, workspace_id: SEED.workspace.id },
      { role: 'owner', user_id: SEED.users.owner.id, workspace_id: SEED.workspace.id },
    ]);
    const session = await stack.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(session).toMatchObject({
      id: SEED.session.id,
      state: 'paused',
      created_by: SEED.users.owner.id,
    });
    expect(session.created_at.toISOString()).toBe(SEED_CREATED_AT);
    const devices = await stack.db
      .selectFrom('devices')
      .select(['id', 'x25519_pub', 'ed25519_pub', 'fingerprint'])
      .orderBy('id')
      .execute();
    expect(devices).toEqual(
      Object.values(SEED.devices).map((d) => ({
        id: d.id,
        x25519_pub: d.x25519Pub,
        ed25519_pub: d.ed25519Pub,
        fingerprint: d.fingerprint,
      })),
    );
  });

  it(
    'writes nothing when a run fails midway, and a rerun then succeeds',
    async () => {
      const other = await startTestStack();
      try {
        // A workspace that already holds the slug acme-dev: the users go in, then the workspace fails.
        const squatter = newId('usr');
        const blocker = newId('wsp');
        await other.db
          .insertInto('users')
          .values({ id: squatter, email: 'squatter@example.test', display_name: 'Squatter' })
          .execute();
        await other.db
          .insertInto('workspaces')
          .values({ id: blocker, name: 'Squatter', slug: 'acme-dev', created_by: squatter })
          .execute();

        await expect(seed(other.db)).rejects.toThrow(/workspaces_slug_key/);
        const users = await other.db.selectFrom('users').select('id').execute();
        expect(users).toEqual([{ id: squatter }]);

        await other.db.deleteFrom('workspaces').where('id', '=', blocker).execute();
        await expect(seed(other.db)).resolves.toMatchObject({ users: 3, workspaces: 1 });
      } finally {
        await other.stop();
      }
    },
    STACK_TIMEOUT_MS,
  );
});
