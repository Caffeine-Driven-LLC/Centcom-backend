/**
 * The trial-ending email (B079, through B032's email service): the `trial_ending` template, sent
 * to the workspace's billing contact when Stripe reports `customer.subscription.trial_will_end`
 * (three days before the trial ends).
 *
 * Owns: the template's copy. Must not: put anything in the mail but the workspace's name and the
 * trial's end (no price, card or account detail).
 */
import { formatDate, markup, type EmailTemplate } from '@centcom/core';

declare module '@centcom/core' {
  interface TemplateParams {
    /** A trial about to end (B079): the workspace's name and when the trial ends. */
    trial_ending: { workspaceName: string; trialEnd: Date };
  }
}

/** The template's id. */
export const TRIAL_ENDING_TEMPLATE_ID = 'trial_ending';

/** The `trial_ending` template. */
export const TRIAL_ENDING_TEMPLATE: EmailTemplate<{ workspaceName: string; trialEnd: Date }> = {
  params: { workspaceName: 'text', trialEnd: 'date' },
  subject: () => 'Your Centcom trial ends soon',
  html: (p) =>
    markup`<p>The Centcom trial of ${p.workspaceName} ends on ${formatDate(p.trialEnd)}.</p>
<p>To keep your plan after the trial, add a payment method on the billing page before then.</p>`,
  text: (p) =>
    [
      `The Centcom trial of ${p.workspaceName} ends on ${formatDate(p.trialEnd)}.`,
      'To keep your plan after the trial, add a payment method on the billing page before then.',
    ].join('\n\n'),
};
