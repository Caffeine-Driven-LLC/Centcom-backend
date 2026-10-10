/**
 * The payment-failed reminder email (B078, through B032's email service): the
 * `billing_payment_failed` template, sent to the workspace's billing contact on grace days 0, 3
 * and 6, as B079 sends its trial-ending email. The workspace's members get the `billing_issue`
 * notification (CT-NOTIF-PAYLOAD) beside it.
 *
 * Owns: the template's copy. Must not: put anything in the mail but the workspace's name and when
 * the grace ends (no amount, card, invoice or Stripe id).
 */
import { formatDate, markup, type EmailTemplate } from '@centcom/core';

declare module '@centcom/core' {
  interface TemplateParams {
    /** A failed payment in its grace window (B078): the workspace's name and the grace's end. */
    billing_payment_failed: { workspaceName: string; graceUntil: Date };
  }
}

/** The template's id. */
export const PAYMENT_FAILED_TEMPLATE_ID = 'billing_payment_failed';

/** The `billing_payment_failed` template. */
export const PAYMENT_FAILED_TEMPLATE: EmailTemplate<{ workspaceName: string; graceUntil: Date }> = {
  params: { workspaceName: 'text', graceUntil: 'date' },
  subject: () => 'Your Centcom payment failed',
  html: (p) =>
    markup`<p>The latest payment for ${p.workspaceName} did not go through.</p>
<p>The plan stays as it is until ${formatDate(p.graceUntil)}. Update the payment method on the billing page before then to keep it; after that the workspace moves to the free plan. No data is deleted.</p>`,
  text: (p) =>
    [
      `The latest payment for ${p.workspaceName} did not go through.`,
      `The plan stays as it is until ${formatDate(p.graceUntil)}. Update the payment method on the billing page before then to keep it; after that the workspace moves to the free plan. No data is deleted.`,
    ].join('\n\n'),
};
