/**
 * Email configuration (B032): which provider sends (`postmark`, `memory` or `console`), the sender
 * line, Postmark's server token (a secret, required only for Postmark) and the provider timeout.
 *
 * Owns: reading and checking these keys, and building the configured provider. Must not: put the
 * token anywhere but the Postmark request header.
 */
import { z } from 'zod';
import { defineConfig, envInt, type Env } from '../config/define.js';
import { secretString, type Secret } from '../config/secret.js';
import type { Logger } from '../log/logger.js';
import {
  ConsoleEmailProvider,
  MemoryEmailProvider,
  PostmarkProvider,
  type EmailProvider,
} from './providers.js';
import { checkSender } from './validation.js';

/** The providers EMAIL_PROVIDER names. */
export const EMAIL_PROVIDERS = ['postmark', 'memory', 'console'] as const;
/** A provider name. */
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];
/** How long one provider call may take by default. */
export const DEFAULT_EMAIL_TIMEOUT_MS = 10_000;

/** The email environment keys (rendered into docs/config.md and .env.example). */
export const emailEnvSchema = z
  .object({
    EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('console').meta({
      description:
        'Who sends email: postmark (production), memory (tests: kept in memory) or console (logs the template only).',
      example: 'console',
    }),
    EMAIL_FROM: z
      .string()
      .refine((value) => {
        try {
          checkSender(value);
          return true;
        } catch {
          return false;
        }
      }, 'must be `address` or `Display Name <address>`')
      .meta({
        description: 'Sender of every email: `address` or `Display Name <address>`.',
        example: 'Centcom <no-reply@centcom.test>',
        envType: 'sender',
      }),
    POSTMARK_SERVER_TOKEN: secretString().optional().meta({
      description: 'Postmark server token; required when EMAIL_PROVIDER is postmark.',
      example: '',
    }),
    EMAIL_TIMEOUT_MS: envInt({ min: 1000, max: 60_000 }).default(DEFAULT_EMAIL_TIMEOUT_MS).meta({
      description: 'Longest wait for one provider call, in milliseconds; slower calls are retried.',
      example: '10000',
    }),
  })
  .superRefine((values, ctx) => {
    if (values.EMAIL_PROVIDER === 'postmark' && values.POSTMARK_SERVER_TOKEN === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['POSTMARK_SERVER_TOKEN'],
        message: 'is required when EMAIL_PROVIDER is postmark',
      });
    }
  });

/** Checked email settings. */
export interface EmailConfig {
  provider: EmailProviderName;
  from: string;
  postmarkToken?: Secret;
  timeoutMs: number;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function emailConfig(env?: Env): EmailConfig {
  const v = defineConfig(emailEnvSchema, env);
  return {
    provider: v.EMAIL_PROVIDER,
    from: v.EMAIL_FROM,
    ...(v.POSTMARK_SERVER_TOKEN === undefined ? {} : { postmarkToken: v.POSTMARK_SERVER_TOKEN }),
    timeoutMs: v.EMAIL_TIMEOUT_MS,
  };
}

/** The provider `config` names; `logger` is what the console provider writes to. */
export function createEmailProvider(
  config: Pick<EmailConfig, 'provider' | 'postmarkToken'>,
  logger: Logger,
): EmailProvider {
  switch (config.provider) {
    case 'postmark':
      if (config.postmarkToken === undefined) {
        throw new TypeError('the postmark provider needs POSTMARK_SERVER_TOKEN');
      }
      return new PostmarkProvider({ token: config.postmarkToken });
    case 'memory':
      return new MemoryEmailProvider();
    case 'console':
      return new ConsoleEmailProvider(logger);
  }
}
