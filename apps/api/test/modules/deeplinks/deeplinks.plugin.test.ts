/**
 * The deep-links plugin (B033, card test deeplinks.plugin.test.ts): it decorates the instance with
 * B029's InviteUrlBuilder and the notification link builder, on WEB_BASE_URL (default
 * `https://centcom.dev`; a non-https value fails at registration); the links it builds read back
 * through parseDeepLink, and a notification built with one passes CT-NOTIF-PAYLOAD's schema.
 */
import { readFileSync } from 'node:fs';
import { validate } from '@centcom/contracts';
import {
  ConfigError,
  deeplinkConfig,
  LINK_TTL,
  parseDeepLink,
  type DeeplinkConfig,
} from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInviteUrlBuilder,
  deeplinksPlugin,
  notificationDeeplink,
} from '../../../src/modules/deeplinks/index.js';
import { INVITE_TTL_MS, type InviteUrlBuilder } from '../../../src/modules/invites/index.js';
import { newInviteToken } from '../../../src/modules/invites/tokens.js';

const SES = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const FIXTURE = new URL(
  '../../../../../contracts/fixtures/notification/approval.json',
  import.meta.url,
);

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * A bare instance with the plugin and, after it, a route plugin of its own (as the invite routes
 * are): the decorations must reach it.
 */
async function withPlugin(config?: DeeplinkConfig): Promise<FastifyInstance> {
  app = fastify({ logger: false });
  await app.register(deeplinksPlugin, config === undefined ? {} : { config });
  await app.register(async (routes) => {
    routes.get('/probe/:token', (request) => {
      const { token } = request.params as { token: string };
      return { url: routes.inviteUrls.inviteUrl(token) };
    });
  });
  await app.ready();
  return app;
}

describe('deeplinksPlugin', () => {
  it('decorates the root instance with the invite builder and the notification link', async () => {
    const server = await withPlugin(deeplinkConfig({}));
    expect(server.hasDecorator('inviteUrls')).toBe(true);
    expect(server.hasDecorator('notificationDeeplink')).toBe(true);
    const urls: InviteUrlBuilder = server.inviteUrls;
    const { token } = newInviteToken();
    expect(urls.inviteUrl(token)).toBe(`https://centcom.dev/i/${token}`);
    expect(urls.joinUrl(token)).toBe(`centcom://invite/${token}`);
    expect(parseDeepLink(urls.inviteUrl(token))).toEqual({
      ok: true,
      kind: 'invite',
      form: 'web',
      token,
    });
    expect(parseDeepLink(urls.joinUrl(token))).toMatchObject({ ok: true, kind: 'invite', token });
    expect(server.notificationDeeplink(SES, 'approval')).toBe(
      `centcom://session/${SES}?focus=approval`,
    );
    const res = await server.inject({ method: 'GET', url: `/probe/${token}` });
    expect(res.json()).toEqual({ url: `https://centcom.dev/i/${token}` });
  });

  it('builds invite links on the configured WEB_BASE_URL', async () => {
    const config = deeplinkConfig({ WEB_BASE_URL: 'https://staging.centcom.dev' });
    const server = await withPlugin(config);
    const { token } = newInviteToken();
    expect(server.inviteUrls.inviteUrl(token)).toBe(`https://staging.centcom.dev/i/${token}`);
    // The app link has no host to configure.
    expect(server.inviteUrls.joinUrl(token)).toBe(`centcom://invite/${token}`);
    expect(parseDeepLink(server.inviteUrls.inviteUrl(token), config)).toMatchObject({
      kind: 'invite',
      token,
    });
  });

  it('reads WEB_BASE_URL from the environment when given no config, and refuses http at boot', async () => {
    try {
      vi.stubEnv('WEB_BASE_URL', 'https://env.centcom.dev');
      const server = await withPlugin();
      expect(server.inviteUrls.inviteUrl('T')).toBe('https://env.centcom.dev/i/T');
      await server.close();
      vi.stubEnv('WEB_BASE_URL', 'http://centcom.dev');
      await expect(withPlugin()).rejects.toThrow(ConfigError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('throws for a token that would put a fragment in the link', async () => {
    const server = await withPlugin(deeplinkConfig({}));
    expect(() => server.inviteUrls.inviteUrl('abc#k=key')).toThrow(TypeError);
    expect(() => server.inviteUrls.joinUrl('abc#k=key')).toThrow(TypeError);
    expect(() => server.notificationDeeplink('ses_nope')).toThrow(TypeError);
  });
});

describe('notificationDeeplink', () => {
  it("gives the contract fixture's link, and a payload that passes the schema", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      data: { action: { deeplink: string } };
    };
    const session = /ses_[0-9A-Z]{26}/.exec(fixture.data.action.deeplink)?.[0] ?? '';
    expect(notificationDeeplink(session, 'approval')).toBe(fixture.data.action.deeplink);
    const payload = {
      ...fixture.data,
      action: { type: 'open_session', deeplink: notificationDeeplink(SES, 'queue') },
    };
    expect(validate('notification', payload).ok).toBe(true);
    expect(notificationDeeplink(SES)).toBe(`centcom://session/${SES}`);
  });
});

describe('alongside B029', () => {
  it('matches the invite lifetime invites use (7 days)', () => {
    expect(INVITE_TTL_MS).toBe(LINK_TTL.invite_s * 1000);
  });

  it('builds a link for every token B029 makes', () => {
    const urls = createInviteUrlBuilder();
    for (let i = 0; i < 200; i++) {
      const { token } = newInviteToken();
      expect(parseDeepLink(urls.inviteUrl(token))).toMatchObject({ ok: true, token });
    }
  });
});
