/**
 * Reading links (B033, card test deeplink.parse.test.ts): both forms of each kind are accepted,
 * unknown query parameters ignored, and the acceptance-2 list refused with a neutral
 * `{ ok: false }` (no reason, no echo of the input); plus fragments, `k`, repeated or empty
 * parameters, and the edges of the table's patterns.
 */
import { describe, expect, it } from 'vitest';
import { MAX_DEEP_LINK_LENGTH, parseDeepLink } from '../../src/index.js';
import { CODE, SES, STATE, TOKEN, TOKEN_2 } from './helpers.js';

const WEB = 'https://centcom.dev';

describe('accepted', () => {
  it.each([
    [`${WEB}/j/${TOKEN}`, { kind: 'join', form: 'web', token: TOKEN }],
    [`centcom://join/${TOKEN}`, { kind: 'join', form: 'app', token: TOKEN }],
    [`${WEB}/i/${TOKEN_2}`, { kind: 'invite', form: 'web', token: TOKEN_2 }],
    [`centcom://invite/${TOKEN_2}`, { kind: 'invite', form: 'app', token: TOKEN_2 }],
    [`${WEB}/g/${TOKEN}`, { kind: 'share', form: 'web', token: TOKEN }],
    [`centcom://share/${TOKEN}`, { kind: 'share', form: 'app', token: TOKEN }],
    [`${WEB}/s/${SES}`, { kind: 'session', form: 'web', sessionId: SES, focus: null }],
    [`centcom://session/${SES}`, { kind: 'session', form: 'app', sessionId: SES, focus: null }],
    [
      `centcom://session/${SES}?focus=approval`,
      { kind: 'session', form: 'app', sessionId: SES, focus: 'approval' },
    ],
    [
      `centcom://session/${SES}?focus=queue`,
      { kind: 'session', form: 'app', sessionId: SES, focus: 'queue' },
    ],
    [
      `${WEB}/s/${SES}?focus=queue`,
      { kind: 'session', form: 'web', sessionId: SES, focus: 'queue' },
    ],
    [`${WEB}/billing`, { kind: 'billing', form: 'web' }],
    ['centcom://billing', { kind: 'billing', form: 'app' }],
    [
      `centcom://auth/callback?code=${CODE}&state=${STATE}`,
      { kind: 'auth_callback', form: 'app', code: CODE, state: STATE },
    ],
    [
      `centcom://auth/callback?state=${STATE}&code=${CODE}`,
      { kind: 'auth_callback', form: 'app', code: CODE, state: STATE },
    ],
  ])('%s', (input, expected) => {
    expect(parseDeepLink(input)).toEqual({ ok: true, ...expected });
  });

  it('ignores unknown query parameters, in both forms of each kind', () => {
    const extra = 'utm_source=mail&ref=a%20b&flag&x=1=2&&';
    expect(parseDeepLink(`${WEB}/j/${TOKEN}?${extra}`)).toMatchObject({ ok: true, kind: 'join' });
    expect(parseDeepLink(`centcom://join/${TOKEN}?${extra}`)).toMatchObject({ kind: 'join' });
    expect(parseDeepLink(`${WEB}/i/${TOKEN}?${extra}`)).toMatchObject({ kind: 'invite' });
    expect(parseDeepLink(`centcom://share/${TOKEN}?${extra}`)).toMatchObject({ kind: 'share' });
    expect(parseDeepLink(`${WEB}/billing?${extra}`)).toMatchObject({ kind: 'billing' });
    expect(parseDeepLink(`centcom://billing?${extra}`)).toMatchObject({ kind: 'billing' });
    expect(parseDeepLink(`centcom://session/${SES}?${extra}&focus=approval`)).toEqual({
      ok: true,
      kind: 'session',
      form: 'app',
      sessionId: SES,
      focus: 'approval',
    });
    expect(
      parseDeepLink(`centcom://auth/callback?${extra}&code=${CODE}&state=${STATE}`),
    ).toMatchObject({ kind: 'auth_callback', code: CODE, state: STATE });
    // focus means nothing to a join link: unknown there, so ignored.
    expect(parseDeepLink(`centcom://join/${TOKEN}?focus=other`)).toMatchObject({ kind: 'join' });
    expect(parseDeepLink(`${WEB}/j/${TOKEN}?`)).toMatchObject({ kind: 'join' });
  });
});

describe('refused, neutrally (acceptance 2)', () => {
  const refused = (input: string): void => {
    const result = parseDeepLink(input);
    expect(result).toEqual({ ok: false });
    expect(Object.keys(result)).toEqual(['ok']);
  };

  it.each([
    // wrong host
    `https://evil.test/j/${TOKEN}`,
    `https://centcom.dev.evil.test/j/${TOKEN}`,
    `https://evil.test/centcom.dev/j/${TOKEN}`,
    `https://centcom.dev@evil.test/j/${TOKEN}`,
    `https://user@centcom.dev/j/${TOKEN}`,
    `https://centcom.dev:8443/j/${TOKEN}`,
    `https://www.centcom.dev/j/${TOKEN}`,
    `https://CENTCOM.DEV/j/${TOKEN}`,
    `//centcom.dev/j/${TOKEN}`,
    // http:// and other schemes
    `http://centcom.dev/j/${TOKEN}`,
    `ftp://centcom.dev/j/${TOKEN}`,
    `HTTPS://centcom.dev/j/${TOKEN}`,
    `CENTCOM://join/${TOKEN}`,
    `centcom:join/${TOKEN}`,
    `centcom:/join/${TOKEN}`,
    `javascript://centcom.dev/j/${TOKEN}`,
    // token with characters outside base64url
    `${WEB}/j/${TOKEN.slice(0, 26)}+`,
    `${WEB}/j/${TOKEN.slice(0, 26)}/`,
    `${WEB}/j/${TOKEN.slice(0, 26)}=`,
    `centcom://join/${TOKEN.slice(0, 26)}.`,
    `centcom://invite/${TOKEN.slice(0, 25)}%41`,
    `centcom://share/${TOKEN.slice(0, 26)}é`,
    // token length != 27
    `${WEB}/j/${TOKEN.slice(0, 26)}`,
    `${WEB}/j/${TOKEN}A`,
    `centcom://join/${TOKEN.slice(0, 26)}`,
    `centcom://invite/${TOKEN}A`,
    `${WEB}/j/`,
    'centcom://join/',
    // ses_ id failing CT-IDS
    `${WEB}/s/wsp_${SES.slice(4)}`,
    `centcom://session/${SES.slice(0, -1)}`,
    `centcom://session/${SES}0`,
    `centcom://session/${SES.toLowerCase()}`,
    `centcom://session/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4U`,
    `centcom://session/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4I`,
    `centcom://session/SES_${SES.slice(4)}`,
    // focus=other, and other bad focuses
    `centcom://session/${SES}?focus=other`,
    `${WEB}/s/${SES}?focus=other`,
    `centcom://session/${SES}?focus=`,
    `centcom://session/${SES}?focus`,
    `centcom://session/${SES}?focus=Approval`,
    `centcom://session/${SES}?focus=approval&focus=queue`,
    `centcom://session/${SES}?focus=approval&focus=approval`,
    `centcom://session/${SES}?focus=approval%00`,
  ])('%s', refused);

  it.each([
    // a fragment, and key material in the query
    `${WEB}/j/${TOKEN}#k=a2V5`,
    `${WEB}/j/${TOKEN}#`,
    `centcom://join/${TOKEN}#k=a2V5`,
    `${WEB}/j/${TOKEN}?k=a2V5`,
    `centcom://invite/${TOKEN}?x=1&k=a2V5`,
    `centcom://session/${SES}?k`,
    // paths off the table
    `${WEB}/j/${TOKEN}/`,
    `${WEB}/j//${TOKEN}`,
    `${WEB}/J/${TOKEN}`,
    `${WEB}/billing/`,
    `${WEB}/Billing`,
    `${WEB}/`,
    WEB,
    `${WEB}/x/${TOKEN}`,
    `${WEB}/auth/callback?code=${CODE}&state=${STATE}`,
    'centcom://billing/',
    'centcom://',
    'centcom://teleport/anywhere',
    `centcom://join/${TOKEN}/extra`,
    `centcom://session/${SES}/approval`,
    // the auth callback: both parameters, once each, unreserved characters only
    'centcom://auth/callback',
    `centcom://auth/callback?code=${CODE}`,
    `centcom://auth/callback?state=${STATE}`,
    `centcom://auth/callback?code=&state=${STATE}`,
    `centcom://auth/callback?code=${CODE}&state`,
    `centcom://auth/callback?code=${CODE}&code=${CODE}&state=${STATE}`,
    `centcom://auth/callback?code=a%20b&state=${STATE}`,
    `centcom://auth/callback?code=${'c'.repeat(513)}&state=${STATE}`,
    `centcom://auth/callback/?code=${CODE}&state=${STATE}`,
    // characters a URL parser would quietly fix
    ` ${WEB}/j/${TOKEN}`,
    `${WEB}/j/${TOKEN} `,
    `${WEB}/j/${TOKEN}?a=b c`,
    `https:\\\\centcom.dev\\j\\${TOKEN}`,
    `https://centcom.dev/j/\t${TOKEN}`,
    `https://centcom.dev/./j/${TOKEN}`,
    `https://centcom.dev/x/../j/${TOKEN}`,
    `https://centcom.dev/%6A/${TOKEN}`,
    '',
  ])('%j', refused);

  it(`refuses anything longer than ${MAX_DEEP_LINK_LENGTH} characters, before matching`, () => {
    const pad = 'x'.repeat(MAX_DEEP_LINK_LENGTH);
    refused(`${WEB}/j/${TOKEN}?pad=${pad}`);
    expect(parseDeepLink(`${WEB}/j/${TOKEN}?p=${'x'.repeat(1000)}`)).toMatchObject({ ok: true });
  });

  it('refuses what is not a string, without throwing', () => {
    for (const value of [undefined, null, 42, {}, ['centcom://billing'], Symbol('x')]) {
      expect(parseDeepLink(value as unknown as string)).toEqual({ ok: false });
    }
  });

  it('says nothing about the input when refusing it', () => {
    const secret = `${WEB}/j/${TOKEN}#k=c2VjcmV0LWtleQ`;
    const result = parseDeepLink(secret);
    expect(JSON.stringify(result)).toBe('{"ok":false}');
    expect(Object.isFrozen(result)).toBe(true);
  });
});
