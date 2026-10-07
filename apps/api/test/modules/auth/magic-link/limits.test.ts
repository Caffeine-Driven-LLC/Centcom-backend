/**
 * Abuse limits (B014, card test limits.test.ts; acceptance 5): the 6th link for one address within
 * an hour is not sent but answered exactly like the others; the 21st request from one address in a
 * minute is refused with 429 (the rate limiter's auth bucket, B023).
 */
import { describe, expect, it } from 'vitest';
import { magicLinkApp, requestLink } from './helpers.js';

describe('the per-address limit', () => {
  it('sends 5 links an hour; the 6th answers the same 202 and sends nothing', async () => {
    const { app, service, mailer, clock, recorded } = await magicLinkApp();
    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push(
        await requestLink(app, i % 2 === 0 ? 'ada@example.test' : 'ADA@example.test', {
          ip: `198.51.100.${i}`,
        }),
      );
    }
    await service.idle();
    expect(mailer.sent).toHaveLength(5);
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(recorded.count('magic_link_limited_total')).toBe(1);
    // Other addresses are not affected; an hour later the address may ask again.
    await requestLink(app, 'grace@example.test', { ip: '198.51.100.50' });
    clock.advance(60 * 60 * 1000);
    await requestLink(app, 'ada@example.test', { ip: '198.51.100.51' });
    await service.idle();
    expect(mailer.sent).toHaveLength(7);
  });
});

describe('the per-IP limit', () => {
  it('refuses the 21st request from one IP within a minute with 429, and no other IP', async () => {
    const { app } = await magicLinkApp();
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      statuses.push(
        (await requestLink(app, `user${i}@example.test`, { ip: '203.0.113.7' })).statusCode,
      );
    }
    expect(statuses.slice(0, 20).every((s) => s === 202)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await requestLink(app, 'other@example.test', { ip: '198.51.100.9' })).statusCode).toBe(
      202,
    );
  });
});
