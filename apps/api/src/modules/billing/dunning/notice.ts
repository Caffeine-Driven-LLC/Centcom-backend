/**
 * The drop-to-free notice (B078, CT-ENTITLEMENTS §4 "Live hosted sessions get `sys.notice
 * plan_changed`"; CT-WS-SESSION-EVENTS Notices: `plan_changed {plan}`, level `info`): published
 * on the Redis channel `relay:notice:{wsp}`, which the relay's fan-out sends to every live
 * session of the workspace (the channel B076 and B090 publish their notices on).
 *
 * Owns: the message. Must not: carry anything but the code, its level and the plan.
 */
import type { PubSub } from '@centcom/core';

/** The channel of a workspace's notices. */
export const dunningNoticeChannel = (workspaceId: string): string => `relay:notice:${workspaceId}`;

/** The notice a drop to `none` sends (the plan is the free plan's id). */
export const PLAN_CHANGED_NOTICE = Object.freeze({
  code: 'plan_changed',
  level: 'info',
  params: Object.freeze({ plan: 'free' }),
});

/** Publishes `plan_changed {plan: 'free'}` to the workspace's live sessions. */
export async function publishPlanChanged(
  notices: Pick<PubSub, 'publish'>,
  workspaceId: string,
): Promise<void> {
  await notices.publish(dunningNoticeChannel(workspaceId), JSON.stringify(PLAN_CHANGED_NOTICE));
}
