/**
 * SSRF defence (B081 acceptance 4 and 5): an endpoint whose URL is, or resolves to, 127.0.0.1,
 * 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254, ::1 or fc00::/7 is refused on create
 * with 422 `webhook_url_invalid`, as is `http://`, a URL with credentials or over 2048 characters.
 * At delivery the host is resolved and checked again: a name that later resolves to a private
 * address (DNS rebinding) fails the attempt with `blocked_destination` and sends nothing; the
 * attempt connects to the checked address, never resolving again. Loopback endpoints are allowed
 * only in test mode, which production refuses to start with.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import { ConfigError, type WebhookEvent } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { loadWebhookConfig } from '../../src/modules/webhooks/config.js';
import {
  isAllowedAddress,
  resolveDestination,
  urlShapeProblem,
} from '../../src/modules/webhooks/destination.js';
import type { WebhookSender } from '../../src/modules/webhooks/http.js';
import { recordingCtx, tableResolver, testConfig, webhookService } from './helpers.js';

const WS = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const PRIVATE = [
  '127.0.0.1',
  '10.1.2.3',
  '172.16.0.9',
  '172.31.255.1',
  '192.168.1.1',
  '169.254.169.254',
  '::1',
  'fc00::1',
  'fd12:3456::1',
];

async function createWith(url: string, resolve = tableResolver({}), allowLoopback = false) {
  const t = webhookService({ config: testConfig(allowLoopback), resolve });
  const { ctx } = recordingCtx();
  return {
    t,
    result: await t.service
      .create(WS, { url, events: ['*'] }, ctx as never)
      .catch((e: unknown) => e),
  };
}

describe('on create', () => {
  it.each(PRIVATE)(
    'refuses a host resolving to %s with 422 webhook_url_invalid',
    async (address) => {
      const { result } = await createWith(
        'https://hooks.example.com/in',
        tableResolver({ 'hooks.example.com': [address] }),
      );
      expect(result).toMatchObject({ code: 'webhook_url_invalid' });
    },
  );

  it.each([
    'https://127.0.0.1/in',
    'https://10.0.0.1/in',
    'https://[::1]/in',
    'https://[fd00::1]/in',
    'https://169.254.169.254/latest',
  ])('refuses the literal %s', async (url) => {
    expect((await createWith(url)).result).toMatchObject({ code: 'webhook_url_invalid' });
  });

  it('refuses http://, credentials, a name with any private address, and URLs over 2048 characters', async () => {
    const pub = tableResolver({
      'hooks.example.com': ['93.184.216.34'],
      'mixed.example.com': ['93.184.216.34', '10.0.0.1'],
    });
    for (const url of [
      'http://hooks.example.com/in',
      'https://user:pw@hooks.example.com/in',
      'https://mixed.example.com/in',
      `https://hooks.example.com/${'a'.repeat(2048)}`,
      'ftp://hooks.example.com/in',
      'not a url',
    ]) {
      expect((await createWith(url, pub)).result, url).toMatchObject({
        code: 'webhook_url_invalid',
      });
    }
    const ok = await createWith('https://hooks.example.com/in', pub);
    expect(ok.result).toMatchObject({ url: 'https://hooks.example.com/in' });
  });
});

describe('at delivery', () => {
  it('fails with blocked_destination when the name now resolves privately (rebinding), sending nothing', async () => {
    const resolve = tableResolver({ 'hooks.example.com': ['93.184.216.34'] });
    const sent: unknown[] = [];
    const sender: WebhookSender = (req) => {
      sent.push(req);
      return Promise.resolve({ ok: true, status: 200, durationMs: 1, excerpt: '' });
    };
    const t = webhookService({ config: testConfig(false), resolve, sender });
    const { ctx } = recordingCtx();
    await t.service.create(
      WS,
      { url: 'https://hooks.example.com/in', events: ['*'] },
      ctx as never,
    );
    const event: WebhookEvent = {
      id: crypto.randomUUID(),
      type: 'session.member.left',
      workspace: WS,
      data: { session: newId('ses'), member: newId('mem') },
      created_at: new Date().toISOString(),
    };
    await t.service.fanOut(event);
    const id = t.queue.jobs[0]?.data.deliveryId ?? '';
    for (const address of ['10.0.0.7', '169.254.169.254', '::1']) {
      resolve.set('hooks.example.com', ['93.184.216.34', address]);
      const result = await t.service.attempt(
        id,
        (t.repository.deliveries.get(id)?.attempt ?? 0) + 1,
      );
      expect(result.next).not.toBeNull();
      expect(t.repository.deliveries.get(id)?.lastError).toBe('blocked_destination');
    }
    expect(sent).toEqual([]);
    // Public again: the attempt connects to the address checked, by name for Host and SNI.
    resolve.set('hooks.example.com', ['93.184.216.34']);
    await t.service.attempt(id, (t.repository.deliveries.get(id)?.attempt ?? 0) + 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ destination: { address: '93.184.216.34', family: 4 } });
    expect((sent[0] as { destination: { url: URL } }).destination.url.hostname).toBe(
      'hooks.example.com',
    );
  });

  it('resolves once per attempt and checks every address', async () => {
    let lookups = 0;
    const resolve = (host: string) => {
      lookups += 1;
      return Promise.resolve(
        host === 'two.example.com' ? ['93.184.216.34', '192.168.0.2'] : ['93.184.216.34'],
      );
    };
    await expect(resolveDestination('https://two.example.com/x', resolve, false)).rejects.toThrow();
    await expect(
      resolveDestination('https://one.example.com/x', resolve, false),
    ).resolves.toMatchObject({ address: '93.184.216.34' });
    expect(lookups).toBe(2);
  });
});

describe('test mode', () => {
  it('allows loopback only when WEBHOOK_ALLOW_LOOPBACK is set, and never in production', () => {
    expect(urlShapeProblem('http://127.0.0.1:8080/x', true)).toBeNull();
    expect(urlShapeProblem('http://localhost:8080/x', true)).toBeNull();
    expect(urlShapeProblem('http://127.0.0.1:8080/x', false)).not.toBeNull();
    expect(urlShapeProblem('http://10.0.0.1/x', true)).not.toBeNull();
    expect(isAllowedAddress('127.0.0.1', true)).toBe(true);
    expect(isAllowedAddress('10.0.0.1', true)).toBe(false);
    const key = randomBytes(32).toString('base64');
    expect(
      loadWebhookConfig({
        WEBHOOK_SECRET_KEY: key,
        WEBHOOK_ALLOW_LOOPBACK: 'true',
        NODE_ENV: 'test',
      }).allowLoopback,
    ).toBe(true);
    let error: unknown;
    try {
      loadWebhookConfig({
        WEBHOOK_SECRET_KEY: key,
        WEBHOOK_ALLOW_LOOPBACK: 'true',
        NODE_ENV: 'production',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues[0]?.key).toBe('WEBHOOK_ALLOW_LOOPBACK');
    expect(() =>
      loadWebhookConfig({ WEBHOOK_SECRET_KEY: randomBytes(16).toString('base64') }),
    ).toThrow(ConfigError);
  });
});
