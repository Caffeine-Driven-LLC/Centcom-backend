/**
 * `pnpm dev:token <owner|member>` (B103): prints an access token for a seeded user on that user's
 * seeded device (tools/dev/seed.ts), as JSON. For scripts that act as a person without the e-mail
 * sign-in: pair it with `seedDevicePrivateKey` for the device's keys. The token is signed with the
 * key `pnpm dev:api` keeps in `.env.local`, so the API accepts it while that key is unchanged.
 *
 * Only for the dev stack: it refuses to run against another database or with
 * NODE_ENV=production. The work is `apps/api/src/dev-token.ts`, started as a child like
 * `dev:api` starts the service.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SEED, assertSeedTarget, type SeedDevice, type SeedUser } from './seed.js';

const WHO: Record<string, { user: SeedUser; device: SeedDevice }> = {
  owner: { user: 'owner', device: 'ownerLaptop' },
  member: { user: 'member', device: 'memberDesktop' },
};

const root = resolve(import.meta.dirname, '../..');
const who = WHO[process.argv[2] ?? ''];
if (who === undefined) {
  process.stderr.write('usage: pnpm dev:token <owner|member>\n');
  process.exit(1);
}
const envFile = resolve(root, '.env.local');
const databaseUrl =
  process.env['DATABASE_URL'] ??
  (existsSync(envFile)
    ? /^DATABASE_URL=(.*)$/m
        .exec(readFileSync(envFile, 'utf8'))?.[1]
        ?.replace(/^(['"])(.*)\1$/, '$2')
    : undefined);
try {
  assertSeedTarget(databaseUrl ?? '', process.env['NODE_ENV']);
} catch (err) {
  process.stderr.write(`dev:token: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
const run = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    resolve(root, 'apps/api/src/dev-token.ts'),
    SEED.users[who.user].id,
    SEED.devices[who.device].id,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.test.json') },
  },
);
process.exit(run.status ?? 1);
