/**
 * `return_to` (B014, card test redirect.test.ts; acceptance 6): only exactly allow-listed URLs are
 * honoured; everything else, including `//evil.example` and `javascript:` URLs, is replaced by the
 * default before it is stored, and never redirected to.
 */
import { describe, expect, it } from 'vitest';
import { csrfFor } from '../../../../src/routes/login-email.js';
import { ALLOWLIST, magicLinkApp, nonceOf, requestLink, tokenOf, useLink } from './helpers.js';

const DEFAULT = ALLOWLIST[0];

describe('return_to', () => {
  it.each([
    [
      'an allow-listed URL',
      'https://app.centcom.test/settings',
      'https://app.centcom.test/settings',
    ],
    ['the default itself', 'https://app.centcom.test/', DEFAULT],
    ['a protocol-relative URL', '//evil.example', DEFAULT],
    ['a javascript: URL', 'javascript:alert(document.cookie)', DEFAULT],
    ['another host', 'https://evil.example/', DEFAULT],
    [
      'an allow-listed URL with a query',
      'https://app.centcom.test/settings?next=//evil.example',
      DEFAULT,
    ],
    ['a look-alike host', 'https://app.centcom.test.evil.example/', DEFAULT],
    ['a path', '/settings', DEFAULT],
    ['nothing', undefined, DEFAULT],
  ])('%s goes to %s (acceptance 6)', async (_name, returnTo, expected) => {
    const { app, service, store, mailer } = await magicLinkApp();
    const nonce = nonceOf(
      await requestLink(app, 'ada@example.test', {
        ...(returnTo === undefined ? {} : { returnTo }),
      }),
    );
    await service.idle();
    expect(store.rows[0]?.returnTo).toBe(expected);
    const response = await useLink(app, tokenOf(mailer.sent[0]?.link ?? ''), nonce, csrfFor(nonce));
    expect(response.statusCode).toBe(303);
    expect(response.headers['location']).toBe(expected);
    expect(ALLOWLIST).toContain(response.headers['location']);
  });
});
