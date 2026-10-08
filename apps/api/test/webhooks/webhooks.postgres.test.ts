/**
 * The webhook repository on Postgres 16 (B081; DATABASE_URL, CI's integration job): 10 concurrent
 * creates against a limit of 2 store exactly 2 (one lock per workspace); a sealed secret is stored,
 * never the secret; fan-out stores an event once, and only enabled endpoints subscribed to the type
 * (or `*`) match; an attempt is recorded once (compare-and-set); 5 concurrent failures past the
 * disable period turn the endpoint off for exactly one of them; the outbox drains in order and
 * leaves nothing behind.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { sealBody, Secret } from '@centcom/core';
import type { WebhookDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createWebhookRepository } from '../../src/modules/webhooks/repository.js';
import { pgJoin, pgUser, pgWorkspace } from '../notifications/dispatcher/postgres.js';
import { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';

const key = new Secret(new Uint8Array(randomBytes(32)));
const noAudit = (): Promise<void> => Promise.resolve();

describe.runIf(ADMIN_URL !== undefined)('webhooks on Postgres 16', () => {
  it('keeps the limit, fans out once, records an attempt once, disables once, drains the outbox', async () => {
    const t = await migratedDatabase(15);
    try {
      const db = t.db as unknown as Kysely<WebhookDb>;
      const repo = createWebhookRepository(db);
      const owner = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, owner);
      await pgJoin(t.db, ws, owner, 'owner');

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => {
          const id = newId('whk');
          return repo.createEndpoint(
            {
              id,
              workspaceId: ws,
              url: `https://hooks.example.com/${i}`,
              events: i % 2 === 0 ? ['*'] : ['session.created'],
              secretEnc: sealBody(key, Buffer.from(`whsec_${i}`), `${id}:secret`),
            },
            2,
            noAudit,
          );
        }),
      );
      const created = results.filter((r) => r !== 'limit');
      expect(created).toHaveLength(2);
      const raw = JSON.stringify(await db.selectFrom('webhook_endpoints').selectAll().execute());
      expect(raw).not.toContain('whsec_');

      const [a] = created;
      if (a === undefined) throw new Error('no endpoint');
      const matching = await repo.matchingEndpoints(ws, 'usage.threshold');
      expect(
        matching.map((e) => e.events.includes('*') || e.events.includes('usage.threshold')),
      ).not.toContain(false);

      const event = {
        id: crypto.randomUUID(),
        workspaceId: ws,
        type: 'session.created',
        data: { session: newId('ses') },
        createdAt: new Date(),
      };
      const dlv = newId('dlv');
      expect(await repo.fanOut(event, [{ id: dlv, endpointId: a.id }])).toBe(true);
      expect(await repo.fanOut(event, [{ id: newId('dlv'), endpointId: a.id }])).toBe(false);
      expect((await repo.findDelivery(dlv))?.event.data).toEqual(event.data);

      const now = new Date();
      const attempt = {
        attempt: 1,
        status: 'pending' as const,
        httpStatus: 500,
        durationMs: 12,
        lastError: 'http_status',
        responseExcerpt: 'err',
        nextAttemptAt: now,
        now,
      };
      const recorded = await Promise.all([
        repo.recordAttempt(dlv, attempt),
        repo.recordAttempt(dlv, attempt),
      ]);
      expect(recorded.filter((r) => r !== null)).toHaveLength(1);
      expect((await repo.findDelivery(dlv))?.delivery.attempt).toBe(1);

      const start = new Date(Date.now() - 4 * 24 * 60 * 60_000);
      await repo.endpointFailed(a.id, start, false, new Date(0));
      const later = new Date();
      const cutoff = new Date(later.getTime() - 3 * 24 * 60 * 60_000);
      const disabled = await Promise.all(
        Array.from({ length: 5 }, () => repo.endpointFailed(a.id, later, true, cutoff)),
      );
      expect(disabled.filter((d) => d.disabled)).toHaveLength(1);
      expect(await repo.findEndpoint(a.id)).toMatchObject({ enabled: false, status: 'disabled' });

      for (const n of [1, 2, 3]) await repo.writeOutbox({ id: `e${n}` });
      const sent: unknown[] = [];
      expect(await repo.drainOutbox(2, async (events) => void sent.push(...events))).toBe(2);
      expect(await repo.drainOutbox(2, async (events) => void sent.push(...events))).toBe(1);
      expect(sent).toEqual([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
      await expect(
        repo.drainOutbox(2, () => Promise.reject(new Error('redis down'))),
      ).resolves.toBe(0);
    } finally {
      await t.drop();
    }
  }, 60_000);
});
