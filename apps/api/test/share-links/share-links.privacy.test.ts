/**
 * Token privacy (B068; tests "share-links.privacy.test.ts", acceptance 2): only the token's
 * SHA-256 is stored (a dump of the store holds no plain token), and neither the token nor a
 * ticket appears in the captured logs or the audit events.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { shareApp } from './helpers.js';

describe('privacy', () => {
  it('stores sha256(token) only, and logs neither the token nor the ticket', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const { ticket } = (await env.join(token, { display_name: 'Guest' }, env.ip())).json();
    await env.revoke(s.sid, token, s.host);
    const dump = JSON.stringify(
      [...env.store.links.values()].map((l) => ({ ...l, tokenHash: l.tokenHash.toString('hex') })),
    );
    expect(dump).not.toContain(token);
    expect(dump).toContain(createHash('sha256').update(token).digest('hex'));
    const logs = env.captured.raw();
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(ticket);
    const audit = JSON.stringify(await env.detached());
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(ticket);
  });
});
