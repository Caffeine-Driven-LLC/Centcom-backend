/**
 * Email configuration (B032): which provider sends (`postmark`, `resend`, `brevo`, `smtp`, `memory` or `console`), the sender
 * line, Postmark's server token (a secret, required only for Postmark) and the provider timeout.
 *
 * Owns: reading and checking these keys, and building the configured provider. Must not: put the
 * token anywhere but the Postmark request header.
 */
import { z } from 'zod';
import { defineConfig, envBool, envInt, type Env } from '../config/define.js';
import { secretString, type Secret } from '../config/secret.js';
import type { Logger } from '../log/logger.js';
import {
  ConsoleEmailProvider,
  MemoryEmailProvider,
  PostmarkProvider,
  type EmailProvider,
} from './providers.js';
import {
  BrevoProvider,
  isLoopbackHost,
  ResendProvider,
  SmtpProvider,
  type SmtpSecure,
} from './providers-more.js';
import { checkSender } from './validation.js';

/** The providers EMAIL_PROVIDER names. */
export const EMAIL_PROVIDERS = [
  'postmark',
  'resend',
  'brevo',
  'smtp',
  'memory',
  'console',
] as const;
/** The providers that deliver real mail (the rest keep it in memory or only log). */
export const REAL_EMAIL_PROVIDERS = ['postmark', 'resend', 'brevo', 'smtp'] as const;
/** A provider name. */
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];
/** How long one provider call may take by default. */
export const DEFAULT_EMAIL_TIMEOUT_MS = 10_000;

/** The email environment keys (rendered into docs/config.md and .env.example). */
export const emailEnvSchema = z
  .object({
    EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('console').meta({
      description:
        'Who sends email: postmark, resend, brevo or smtp (production), memory (tests: kept in memory) or console (logs the template only).',
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
    RESEND_API_KEY: secretString().optional().meta({
      description: 'Resend API key; required when EMAIL_PROVIDER is resend.',
      example: '',
    }),
    BREVO_API_KEY: secretString().optional().meta({
      description: 'Brevo API key (v3); required when EMAIL_PROVIDER is brevo.',
      example: '',
    }),
    SMTP_HOST: z.string().min(1).max(253).optional().meta({
      description: 'SMTP server host name; required when EMAIL_PROVIDER is smtp.',
      example: '',
    }),
    SMTP_PORT: envInt({ min: 1, max: 65535 }).default(587).meta({
      description: 'SMTP server port: 587 for starttls, 465 for tls, 25 for none.',
      example: '587',
    }),
    SMTP_SECURE: z.enum(['tls', 'starttls', 'none']).default('starttls').meta({
      description:
        'SMTP link protection: tls (encrypted from the start, port 465), starttls (upgrade, required) or none (plain text; a trusted local relay only).',
      example: 'starttls',
    }),
    SMTP_ALLOW_CLEARTEXT_AUTH: envBool().default(false).meta({
      description:
        'Allow SMTP_USER and SMTP_PASSWORD over a connection with SMTP_SECURE=none to a host that is not this machine. Off by default: the password would cross the network in clear text.',
      example: 'false',
    }),
    SMTP_USER: z.string().min(1).max(256).optional().meta({
      description: 'SMTP user name; with SMTP_PASSWORD it turns on AUTH PLAIN.',
      example: '',
    }),
    SMTP_PASSWORD: secretString().optional().meta({
      description: 'SMTP password; set together with SMTP_USER.',
      example: '',
    }),
    EMAIL_TIMEOUT_MS: envInt({ min: 1000, max: 60_000 }).default(DEFAULT_EMAIL_TIMEOUT_MS).meta({
      description: 'Longest wait for one provider call, in milliseconds; slower calls are retried.',
      example: '10000',
    }),
  })
  .superRefine((values, ctx) => {
    const need = (provider: string, key: string, present: boolean): void => {
      if (values.EMAIL_PROVIDER === provider && !present) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `is required when EMAIL_PROVIDER is ${provider}`,
        });
      }
    };
    need('postmark', 'POSTMARK_SERVER_TOKEN', values.POSTMARK_SERVER_TOKEN !== undefined);
    need('resend', 'RESEND_API_KEY', values.RESEND_API_KEY !== undefined);
    need('brevo', 'BREVO_API_KEY', values.BREVO_API_KEY !== undefined);
    need('smtp', 'SMTP_HOST', values.SMTP_HOST !== undefined);
    if (
      values.EMAIL_PROVIDER === 'smtp' &&
      values.SMTP_SECURE === 'none' &&
      values.SMTP_USER !== undefined &&
      values.SMTP_HOST !== undefined &&
      !isLoopbackHost(values.SMTP_HOST) &&
      !values.SMTP_ALLOW_CLEARTEXT_AUTH
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_SECURE'],
        message:
          'none would send SMTP_USER and SMTP_PASSWORD in clear text to a host that is not this machine: use starttls or tls, or set SMTP_ALLOW_CLEARTEXT_AUTH=true',
      });
    }
    if ((values.SMTP_USER === undefined) !== (values.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [values.SMTP_USER === undefined ? 'SMTP_USER' : 'SMTP_PASSWORD'],
        message: 'must be set together with its partner (SMTP_USER and SMTP_PASSWORD)',
      });
    }
  });

/** Checked email settings. */
export interface EmailConfig {
  provider: EmailProviderName;
  from: string;
  postmarkToken?: Secret;
  resendKey?: Secret;
  brevoKey?: Secret;
  smtp?: SmtpSettings;
  timeoutMs: number;
}

/** The SMTP settings, present when SMTP_HOST is set. */
export interface SmtpSettings {
  host: string;
  port: number;
  secure: SmtpSecure;
  allowCleartextAuth?: boolean;
  user?: string;
  password?: Secret;
}

/** Reads the settings (default: the process environment, through the config loader). */
export function emailConfig(env?: Env): EmailConfig {
  const v = defineConfig(emailEnvSchema, env);
  return {
    provider: v.EMAIL_PROVIDER,
    from: v.EMAIL_FROM,
    ...(v.POSTMARK_SERVER_TOKEN === undefined ? {} : { postmarkToken: v.POSTMARK_SERVER_TOKEN }),
    ...(v.RESEND_API_KEY === undefined ? {} : { resendKey: v.RESEND_API_KEY }),
    ...(v.BREVO_API_KEY === undefined ? {} : { brevoKey: v.BREVO_API_KEY }),
    ...(v.SMTP_HOST === undefined
      ? {}
      : {
          smtp: {
            host: v.SMTP_HOST,
            port: v.SMTP_PORT,
            secure: v.SMTP_SECURE,
            ...(v.SMTP_ALLOW_CLEARTEXT_AUTH ? { allowCleartextAuth: true } : {}),
            ...(v.SMTP_USER === undefined ? {} : { user: v.SMTP_USER }),
            ...(v.SMTP_PASSWORD === undefined ? {} : { password: v.SMTP_PASSWORD }),
          },
        }),
    timeoutMs: v.EMAIL_TIMEOUT_MS,
  };
}

/** The provider `config` names; `logger` is what the console provider writes to. */
export function createEmailProvider(
  config: Pick<EmailConfig, 'provider' | 'postmarkToken' | 'resendKey' | 'brevoKey' | 'smtp'>,
  logger: Logger,
): EmailProvider {
  switch (config.provider) {
    case 'postmark':
      if (config.postmarkToken === undefined) {
        throw new TypeError('the postmark provider needs POSTMARK_SERVER_TOKEN');
      }
      return new PostmarkProvider({ token: config.postmarkToken });
    case 'resend':
      if (config.resendKey === undefined) {
        throw new TypeError('the resend provider needs RESEND_API_KEY');
      }
      return new ResendProvider({ apiKey: config.resendKey });
    case 'brevo':
      if (config.brevoKey === undefined) {
        throw new TypeError('the brevo provider needs BREVO_API_KEY');
      }
      return new BrevoProvider({ apiKey: config.brevoKey });
    case 'smtp':
      if (config.smtp === undefined) throw new TypeError('the smtp provider needs SMTP_HOST');
      return new SmtpProvider(config.smtp);
    case 'memory':
      return new MemoryEmailProvider();
    case 'console':
      return new ConsoleEmailProvider(logger);
  }
}
