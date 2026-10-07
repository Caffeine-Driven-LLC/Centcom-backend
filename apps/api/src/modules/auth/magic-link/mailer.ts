/**
 * Sign-in link mail (B014): the `MagicLinkMailer` the service sends through, and its adapter over
 * B032's email service with the `magic_link` template (the link, used exactly as given, and how
 * long it lasts).
 *
 * Owns: the template's copy and the adapter. Must not: put anything in the mail but the link and
 * its lifetime (no address, no account state), or log the link.
 */
import { markup, type EmailService, type EmailTemplate } from '@centcom/core';

/** Sends sign-in links; B032's email service satisfies it through `emailMagicLinkMailer`. */
export interface MagicLinkMailer {
  send(to: string, link: string, locale: string): Promise<void>;
}

declare module '@centcom/core' {
  interface TemplateParams {
    /** A sign-in link (B014) and how long it works, such as `15 minutes`. */
    magic_link: { url: string; validFor: string };
  }
}

/** The `magic_link` template. */
export const MAGIC_LINK_TEMPLATE: EmailTemplate<{ url: string; validFor: string }> = {
  params: { url: 'url', validFor: 'text' },
  subject: () => 'Your Centcom sign-in link',
  html: (p) =>
    markup`<p>Use this link to sign in to Centcom. It works once, for ${p.validFor}, in the browser where you asked for it.</p>
<p><a href="${p.url}">Sign in to Centcom</a></p>
<p>If you did not ask to sign in, you can ignore this email.</p>`,
  text: (p) =>
    [
      `Use this link to sign in to Centcom. It works once, for ${p.validFor}, in the browser where you asked for it.`,
      `Sign in to Centcom: ${p.url}`,
      'If you did not ask to sign in, you can ignore this email.',
    ].join('\n\n'),
};

/** `seconds` in words: `15 minutes`, `1 hour`. */
export function lifetime(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * A mailer over B032's `email` service: registers the `magic_link` template on its registry (once)
 * and queues one email per link. `ttlS` is the links' lifetime, for the copy.
 */
export function emailMagicLinkMailer(email: EmailService, ttlS: number): MagicLinkMailer {
  if (!email.templates.ids().includes('magic_link')) {
    email.templates.registerTemplate('magic_link', MAGIC_LINK_TEMPLATE);
  }
  const validFor = lifetime(ttlS);
  return {
    async send(to, link) {
      await email.send('magic_link', to, { url: link, validFor });
    },
  };
}
