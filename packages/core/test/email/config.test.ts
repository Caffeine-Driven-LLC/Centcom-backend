/**
 * Email configuration (B032): EMAIL_PROVIDER, EMAIL_FROM, POSTMARK_SERVER_TOKEN (required for
 * Postmark, a Secret, never echoed) and EMAIL_TIMEOUT_MS (10 s by default); the providers built
 * from it, and the memory and console providers (acceptance 8).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ConsoleEmailProvider,
  createEmailProvider,
  DEFAULT_EMAIL_TIMEOUT_MS,
  emailConfig,
  EmailProviderError,
  MemoryEmailProvider,
  PostmarkProvider,
  Secret,
  type RenderedEmail,
} from '../../src/index.js';
import { captureLogger } from './helpers.js';

const FROM = 'Centcom <no-reply@centcom.test>';
const EMAIL: RenderedEmail = {
  to: 'ada@example.test',
  from: FROM,
  subject: 's',
  html: 'h',
  text: 't',
  tag: 'export_ready',
};

/** The keys of the ConfigError `fn` throws, checking no value from `env` leaks. */
function badKeys(env: Record<string, string>): string[] {
  try {
    emailConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    // The values that could be personal or secret never appear (enum names may: they are ours).
    for (const key of ['EMAIL_FROM', 'POSTMARK_SERVER_TOKEN']) {
      const value = env[key];
      if (value !== undefined) expect((e as Error).message).not.toContain(value);
    }
    return (e as ConfigError).issues.map((i) => i.key);
  }
  throw new Error('expected a ConfigError');
}

describe('emailConfig', () => {
  it('defaults to the console provider and a 10 s timeout', () => {
    expect(emailConfig({ EMAIL_FROM: FROM })).toEqual({
      provider: 'console',
      from: FROM,
      timeoutMs: 10_000,
    });
    expect(DEFAULT_EMAIL_TIMEOUT_MS).toBe(10_000);
  });

  it('reads Postmark with its token as a Secret', () => {
    const token = randomBytes(18).toString('hex');
    const config = emailConfig({
      EMAIL_PROVIDER: 'postmark',
      EMAIL_FROM: 'no-reply@centcom.test',
      POSTMARK_SERVER_TOKEN: token,
      EMAIL_TIMEOUT_MS: '2500',
    });
    expect(config).toMatchObject({ provider: 'postmark', timeoutMs: 2500 });
    expect(config.postmarkToken).toBeInstanceOf(Secret);
    expect(config.postmarkToken?.reveal()).toBe(token);
    expect(JSON.stringify(config)).not.toContain(token);
  });

  it('refuses Postmark without a token, a bad sender, an unknown provider and a bad timeout', () => {
    expect(badKeys({ EMAIL_PROVIDER: 'postmark', EMAIL_FROM: FROM })).toEqual([
      'POSTMARK_SERVER_TOKEN',
    ]);
    expect(badKeys({})).toEqual(['EMAIL_FROM']);
    expect(badKeys({ EMAIL_FROM: 'nobody' })).toEqual(['EMAIL_FROM']);
    expect(badKeys({ EMAIL_FROM: FROM, EMAIL_PROVIDER: 'smtp' })).toEqual(['EMAIL_PROVIDER']);
    expect(badKeys({ EMAIL_FROM: FROM, EMAIL_TIMEOUT_MS: '999' })).toEqual(['EMAIL_TIMEOUT_MS']);
  });
});

describe('createEmailProvider', () => {
  const { logger } = captureLogger();

  it('builds the configured provider', () => {
    expect(createEmailProvider({ provider: 'memory' }, logger)).toBeInstanceOf(MemoryEmailProvider);
    expect(createEmailProvider({ provider: 'console' }, logger)).toBeInstanceOf(
      ConsoleEmailProvider,
    );
    const postmark = createEmailProvider(
      { provider: 'postmark', postmarkToken: new Secret('t') },
      logger,
    );
    expect(postmark).toBeInstanceOf(PostmarkProvider);
    expect(() => createEmailProvider({ provider: 'postmark' }, logger)).toThrow(TypeError);
  });
});

describe('the memory and console providers (acceptance 8)', () => {
  it('memory keeps what it sends, and fails on demand or when aborted', async () => {
    const memory = new MemoryEmailProvider();
    expect(await memory.send(EMAIL, new AbortController().signal)).toEqual({
      providerMessageId: 'memory-1',
    });
    expect(memory.sent).toEqual([EMAIL]);
    memory.failNext = () => new EmailProviderError('rejected', { retryable: false, status: 422 });
    await expect(memory.send(EMAIL, new AbortController().signal)).rejects.toMatchObject({
      failure: 'rejected',
    });
    memory.failNext = undefined;
    await expect(memory.send(EMAIL, AbortSignal.abort())).rejects.toMatchObject({
      failure: 'timeout',
    });
    expect(memory.sent).toHaveLength(1);
  });

  it('console logs the template only', async () => {
    const log = captureLogger();
    const provider = new ConsoleEmailProvider(log.logger);
    expect(await provider.send(EMAIL)).toEqual({ providerMessageId: 'console-1' });
    expect(log.lines()).toEqual([
      expect.objectContaining({
        msg: 'email.console',
        template: 'export_ready',
        provider_message_id: 'console-1',
      }),
    ]);
    expect(log.raw()).not.toContain('ada@example.test');
  });
});
