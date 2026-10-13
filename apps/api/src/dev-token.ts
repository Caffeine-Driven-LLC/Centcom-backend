/**
 * The process behind `pnpm dev:token` (B103): prints, as JSON, an access token for a user on one
 * of their devices, signed with the service's own keys. Development only: it refuses to run with
 * NODE_ENV=production. `tools/dev/token.ts` starts it with the seeded people, after checking that
 * the database is the dev stack's.
 *
 * Usage: dev-token.ts <usr_ id> <dev_ id>   (reads `.env.local` like `pnpm dev:api`)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, createRedis, keyPrefixFor } from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import { loadApiConfig } from './config.js';
import { createContext, type ApiDatabase } from './context.js';
import { SCOPES } from './modules/auth/tokens/service.js';

async function main(): Promise<number> {
  const [userId, deviceId] = process.argv.slice(2);
  if (userId === undefined || deviceId === undefined) {
    process.stderr.write('usage: dev-token <usr_ id> <dev_ id>\n');
    return 1;
  }
  const envFile = resolve(import.meta.dirname, '../../../.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadApiConfig();
  if (config.base.nodeEnv === 'production') {
    process.stderr.write('dev-token: refusing to run with NODE_ENV=production\n');
    return 1;
  }
  const logger = createLogger({
    level: 'error',
    service: 'dev-token',
    version: '0.0.0',
    env: config.base.nodeEnv,
  });
  const db = createDb<ApiDatabase>({ url: config.base.databaseUrl.reveal(), poolMax: 1 });
  const redis = createRedis({
    url: config.base.redisUrl,
    keyPrefix: keyPrefixFor(config.base.nodeEnv),
    logger,
  });
  try {
    const { tokens } = createContext({ config, db, redis, logger });
    const issued = await tokens.issueTokens({
      userId,
      deviceId,
      scopes: SCOPES.filter((scope) => scope !== 'admin'),
    });
    process.stdout.write(
      `${JSON.stringify({
        access_token: issued.access_token,
        refresh_token: issued.refresh_token,
        user: userId,
        device: deviceId,
      })}\n`,
    );
    return 0;
  } finally {
    await Promise.allSettled([closeDb(db), redis.close()]);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : 'dev-token failed'}\n`);
    process.exit(1);
  },
);
