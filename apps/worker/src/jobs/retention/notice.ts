/**
 * What a shortened history retention tells people (B090), 7 days before it takes effect:
 *
 * - **Live hosted sessions:** `sys.notice` `history_retention_changed {days}` (level `info`,
 *   CT-WS-SESSION-EVENTS "Notices"), as JSON on the Redis channel `relay:notice:{wsp}`, which the
 *   relay's fan-out sends to every live session of the workspace (the channel B076 defines for
 *   quota notices). Codes and numbers only.
 * - **Owners:** the `history_retention_changed` email (B032's service): the workspace's name, the
 *   new number of days and when it takes effect; one per owner, with an idempotency key per
 *   shortening, so a retried send is not delivered twice.
 *
 * Owns: the notice body, the template's copy. Must not: put anything else in either (no session,
 * user or content detail).
 */
import { formatDate, markup, type EmailTemplate, type PubSub } from '@centcom/core';

declare module '@centcom/core' {
  interface TemplateParams {
    /** A shortened history retention (B090): the workspace, the new days, when it takes effect. */
    history_retention_changed: { workspaceName: string; days: string; effectiveAt: Date };
  }
}

/** The channel of a workspace's notices (`relay:notice:{wsp}`, as B076's). */
export const retentionNoticeChannel = (workspaceId: string): string =>
  `relay:notice:${workspaceId}`;

/** The `sys.notice` body of a shortened retention. */
export interface RetentionNotice {
  code: 'history_retention_changed';
  level: 'info';
  params: { days: number };
}

/** The notice for a retention of `days`. */
export const retentionNoticeOf = (days: number): RetentionNotice => ({
  code: 'history_retention_changed',
  level: 'info',
  params: { days },
});

/** Publishes the notice on the workspace's channel. */
export async function publishRetentionNotice(
  pubsub: Pick<PubSub, 'publish'>,
  workspaceId: string,
  days: number,
): Promise<void> {
  await pubsub.publish(
    retentionNoticeChannel(workspaceId),
    JSON.stringify(retentionNoticeOf(days)),
  );
}

/** The template's id. */
export const HISTORY_RETENTION_TEMPLATE_ID = 'history_retention_changed';

const keepsLine = (p: { workspaceName: string; days: string; effectiveAt: Date }): string =>
  p.days === '0'
    ? `From ${formatDate(p.effectiveAt)}, ${p.workspaceName} no longer keeps session history after a session ends.`
    : `From ${formatDate(p.effectiveAt)}, ${p.workspaceName} keeps session history for ${p.days} days after a session ends.`;

const OLDER_LINE =
  'History older than that is deleted then. To keep it longer, change the plan or the retention setting before that date.';

/** The `history_retention_changed` template. */
export const HISTORY_RETENTION_TEMPLATE: EmailTemplate<{
  workspaceName: string;
  days: string;
  effectiveAt: Date;
}> = {
  params: { workspaceName: 'text', days: 'text', effectiveAt: 'date' },
  subject: () => 'Session history will be kept for a shorter time',
  html: (p) => markup`<p>${keepsLine(p)}</p>
<p>${OLDER_LINE}</p>`,
  text: (p) => [keepsLine(p), OLDER_LINE].join('\n\n'),
};

/** Adds the template to an email service's registry (`EmailService.templates`). */
export function registerRetentionTemplates(registry: {
  registerTemplate(
    id: typeof HISTORY_RETENTION_TEMPLATE_ID,
    template: typeof HISTORY_RETENTION_TEMPLATE,
  ): void;
}): void {
  registry.registerTemplate(HISTORY_RETENTION_TEMPLATE_ID, HISTORY_RETENTION_TEMPLATE);
}
