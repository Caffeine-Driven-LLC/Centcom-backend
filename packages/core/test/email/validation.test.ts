/**
 * Input rules (B032, card test email.validation.test.ts): header injection (acceptance 2: CR or LF
 * in the recipient, the subject or a name is refused before anything is queued or sent), and
 * address limits (acceptance 3: lower-cased, at most 254 characters, a real address).
 */
import { describe, expect, it } from 'vitest';
import {
  AppError,
  checkSender,
  isAddress,
  MAX_ADDRESS_LENGTH,
  normalizeAddress,
} from '../../src/index.js';
import { params, setup } from './helpers.js';

/** The pointers of the 422 `fn` rejects with. */
async function pointers(fn: () => Promise<unknown>): Promise<string[]> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: 'validation_failed', status: 422 });
    return ((e as AppError).errors ?? []).map((f) => f.pointer);
  }
  throw new Error('expected a validation problem');
}

describe('header injection (acceptance 2)', () => {
  it.each([
    'ada@example.test\r\nBcc: eve@example.test',
    'ada@example.test\n',
    '\rada@example.test',
  ])('refuses the recipient %j before queueing', async (to) => {
    const { service, queue } = setup();
    expect(await pointers(() => service.send('export_ready', to, params.export_ready()))).toEqual([
      '/to',
    ]);
    expect(queue.jobs).toEqual([]);
  });

  it('refuses a name with CR or LF, which would reach the subject', async () => {
    const { service, queue } = setup();
    for (const inviterName of ['Ada\r\nBcc: eve@example.test', 'Ada\nLovelace', 'Ada\r']) {
      const invite = { ...params.workspace_invite(), inviterName };
      expect(
        await pointers(() => service.send('workspace_invite', 'a@example.test', invite)),
      ).toEqual(['/params/inviterName']);
    }
    expect(queue.jobs).toEqual([]);
  });

  it('never lets a line break into a queued header', async () => {
    const { service, queue } = setup();
    await service.send('workspace_invite', 'Ada@Example.TEST', params.workspace_invite());
    const email = queue.jobs[0]?.data.email;
    for (const header of [email?.to, email?.from, email?.subject])
      expect(header).not.toMatch(/[\r\n]/);
  });
});

describe('addresses (acceptance 3)', () => {
  it('lower-cases and trims the recipient', () => {
    expect(normalizeAddress(' Ada.Lovelace+Centcom@Example.TEST ')).toBe(
      'ada.lovelace+centcom@example.test',
    );
  });

  it('accepts 254 characters and refuses 255', () => {
    const at254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(at254).toHaveLength(MAX_ADDRESS_LENGTH);
    expect(normalizeAddress(at254)).toBe(at254);
    const at255 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    expect(() => normalizeAddress(at255)).toThrow(AppError);
  });

  it.each([
    '',
    'ada',
    'ada@',
    '@example.test',
    'ada@example',
    'ada lovelace@example.test',
    'ada@@example.test',
    '"ada"@example.test',
    'ada@-example.test',
    'ada@example..test',
    'Ada <ada@example.test>',
  ])('refuses %j', (address) => {
    expect(() => normalizeAddress(address)).toThrow(AppError);
    expect(isAddress(address)).toBe(false);
  });

  it('refuses a recipient that is not a string', () => {
    expect(() => normalizeAddress(42)).toThrow(AppError);
  });
});

describe('the sender', () => {
  it.each(['no-reply@centcom.test', 'Centcom <no-reply@centcom.test>'])('accepts %j', (from) => {
    expect(checkSender(from)).toBe(from);
  });

  it.each([
    'Centcom',
    'Centcom <not an address>',
    'Cent\ncom <no-reply@centcom.test>',
    '<no-reply@centcom.test>',
    'a"b <x@centcom.test>',
  ])('refuses %j', (from) => {
    expect(() => checkSender(from)).toThrow(TypeError);
  });
});
