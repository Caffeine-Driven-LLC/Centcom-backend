/**
 * No key material anywhere but the create response (B019 acceptance 1, guardrails; card test
 * leak.test.ts): after creating, using, failing with, revoking and rotating keys, the logs, the
 * stored rows and the audit rows hold neither a key nor its unpeppered hash. The Postgres dump is
 * in postgres.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { arrangeWorkspace, bearer, bearerApp } from './helpers.js';

describe('key material', () => {
  it('never reaches the logs, the stored rows or the audit rows', async () => {
    const t = await bearerApp();
    const { workspaceId, users } = arrangeWorkspace(t.ws);
    const token = await t.userToken(users.owner);
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: bearer(token),
      payload: { workspace: workspaceId, name: 'CI', scopes: ['workspaces:read'] },
    });
    const key = String(created.json().secret);
    const id = String(created.json().id);
    await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) });
    await t.app.inject({
      method: 'GET',
      url: '/v1/test/whoami',
      headers: bearer(`${key.slice(0, -1)}0`),
    });
    const rotated = await t.service.rotateApiKey(
      id,
      { type: 'system', id: 'admin-console' },
      {
        audit: () => Promise.resolve('aud_01JA3Z8K2M5N7P9Q0R1S2T3V4W'),
      },
    );
    await t.app.inject({ method: 'GET', url: '/v1/test/whoami', headers: bearer(key) });
    await t.authenticator.settled();

    const material = [key, key.slice(12), rotated.key, rotated.key.slice(12)];
    const unpeppered = [key, rotated.key].map((k) => createHash('sha256').update(k).digest('hex'));
    const places = {
      logs: t.logs(),
      rows: JSON.stringify([...t.keys.keys.values()]),
      audit: JSON.stringify(t.ws.audit),
    };
    for (const [where, text] of Object.entries(places)) {
      for (const secret of [...material, ...unpeppered]) {
        expect(text, where).not.toContain(secret);
      }
    }
    // The stored hash is the peppered one; the prefix is all of the key that is kept.
    const stored = t.keys.keys.get(id);
    expect(stored?.prefix).toBe(key.slice(0, 12));
    expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
