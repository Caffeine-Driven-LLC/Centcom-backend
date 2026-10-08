/**
 * Postgres fixtures for the account lifecycle tests (B026; DATABASE_URL, CI's integration job): one
 * of every personal row a user can have, written straight into a migrated throwaway database.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { sql, type Kysely } from 'kysely';
import type { LifecycleDb, PurgeDb } from '../../src/modules/account-lifecycle/index.js';

/** What `seedPersonalData` wrote. */
export interface Seeded {
  deviceId: string;
  workspaceId: string;
  apiKeyId: string;
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/**
 * A device with a refresh token, a sign-in identity, a notification and preferences, a push
 * subscription, an API key in `workspaceId` (a new workspace of the user's when absent), and two
 * audit events: one the user did, one about the user.
 */
export async function seedPersonalData(
  lifecycleDb: Kysely<LifecycleDb>,
  userId: string,
  workspaceId?: string,
): Promise<Seeded> {
  const db = lifecycleDb as unknown as Kysely<PurgeDb>;
  const deviceId = newId('dev');
  await db
    .insertInto('devices')
    .values({
      id: deviceId,
      user_id: userId,
      name: "Grace's laptop",
      platform: 'linux',
      x25519_pub: 'A'.repeat(43),
      ed25519_pub: 'B'.repeat(43),
      fingerprint: 'AAAA-BBBB-CCCC',
    })
    .execute();
  const now = Date.now();
  await db
    .insertInto('refresh_tokens')
    .values({
      token_hash: hex(32),
      family_id: hex(16),
      user_id: userId,
      device_id: deviceId,
      client_id: 'centcom-cli',
      scope: 'profile',
      expires_at: new Date(now + 86_400_000),
      absolute_expires_at: new Date(now + 2 * 86_400_000),
    })
    .execute();
  await db
    .insertInto('identities')
    .values({ provider: 'github', subject: `gh-${hex(4)}`, user_id: userId })
    .execute();
  await db
    .insertInto('notifications')
    .values({
      id: newId('ntf'),
      user_id: userId,
      event_id: `evt-${hex(4)}`,
      category: 'mention',
      priority: 'normal',
      channels: ['inbox'],
      params: {},
      digest_pending: false,
    })
    .execute();
  await sql`insert into notification_pref (user_id, doc) values (${userId}, '{"email":true}'::jsonb)`.execute(
    db,
  );
  await sql`
    insert into push_subscriptions (id, user_id, kind, token_hash, token_enc)
    values (${newId('psh')}, ${userId}, 'apns', ${randomBytes(32)}, '{"v":1}'::jsonb)
  `.execute(db);
  let workspace = workspaceId;
  if (workspace === undefined) {
    workspace = newId('wsp');
    await db
      .insertInto('workspaces')
      .values({
        id: workspace,
        name: 'Personal',
        slug: `personal-${workspace.slice(-8).toLowerCase()}`,
        created_by: userId,
      })
      .execute();
    await db
      .insertInto('memberships')
      .values({ id: newId('mem'), workspace_id: workspace, user_id: userId, role: 'owner' })
      .execute();
  }
  const apiKeyId = newId('key');
  await sql`
    insert into api_keys (id, workspace_id, created_by, name, mode, key_hash, prefix, scope)
    values (${apiKeyId}, ${workspace}, ${userId}, 'CI', 'live', ${hex(32)},
            ${`cen_live_${hex(2).slice(0, 3)}`}, 'sessions:read')
  `.execute(db);
  await sql`
    insert into audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, outcome)
    values (${newId('aud')}, null, 'user', ${userId}, 'workspace.create', 'workspace', ${workspace}, 'success'),
           (${newId('aud')}, null, 'system', 'relay', 'auth.device_revoked', 'user', ${userId}, 'success')
  `.execute(db);
  return { deviceId, workspaceId: workspace, apiKeyId };
}
