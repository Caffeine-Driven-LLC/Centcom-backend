/**
 * What signals carry (B076 test plan "contract: published notice bodies validate against the
 * sys.notice code/params table of CT-WS-SESSION-EVENTS" and "privacy: notification and webhook
 * payloads contain no usage numbers other than pct"; acceptance 6 "Owners receive notifications
 * only; a member or billing role user receives none, and the notification params contain only ids
 * and enums ({limit: 'hosted_minutes_month', pct: 80}), never text"; guardrail "MUST NOT put
 * display text in notices or notifications"):
 *
 * - each notice's code, level and params keys are read from `contracts/04-session-events.md`
 *   (the Notices table and the `sys.notice` levels row), not restated here;
 * - notifications pass B063's own event rules (`checkEvent`: CT-NOTIF-PAYLOAD's params per
 *   category) and, resolved by B063's `resolveRecipients`, reach the owner only: not an admin,
 *   member, billing member or guest;
 * - webhook events pass B081's emitter (CT-WEBHOOKS' `usage.threshold {limit, pct}`);
 * - no payload holds the use, the limit's size or any text but the limit key.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { resolveRecipients } from '../../../src/modules/notifications/dispatcher/recipients.js';
import { NOW, signalsWith } from './helpers.js';

const contract = readFileSync(
  resolve(__dirname, '../../../../../contracts/04-session-events.md'),
  'utf8',
);

/** The Notices table: code → params keys. */
function noticeTable(): Map<string, string[]> {
  const table = new Map<string, string[]>();
  const section = contract.slice(contract.indexOf('### Notices'));
  for (const m of section.matchAll(/^\| `([a-z_]+)` \| `\{([a-z_, ]*)\}` \|$/gm)) {
    table.set(
      m[1] ?? '',
      (m[2] ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    );
    if (table.size >= 7) break;
  }
  return table;
}

/** The `sys.notice` levels row: code → level. */
function noticeLevels(): Map<string, string> {
  const row = contract.split('\n').find((l) => l.startsWith('| `sys.notice` levels |')) ?? '';
  return new Map([...row.matchAll(/`([a-z_]+)`→`([a-z]+)`/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
}

describe('signal payloads', () => {
  it('publishes notices exactly as the CT-WS-SESSION-EVENTS Notices table says', async () => {
    const table = noticeTable();
    const levels = noticeLevels();
    expect(table.get('usage_warning')).toEqual(['pct', 'resets_at']);
    expect(levels.get('quota_reached')).toBe('error');

    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 7000, 1000);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    expect(ctx.notices.published.map((p) => p.notice.code)).toEqual([
      'usage_warning',
      'usage_warning',
      'quota_reached',
      'quota_reached',
    ]);
    for (const { channel, notice } of ctx.notices.published) {
      expect(channel).toBe(`relay:notice:${ctx.ws}`);
      expect(Object.keys(notice).sort()).toEqual(['code', 'level', 'params']);
      expect(Object.keys(notice.params).sort()).toEqual(table.get(notice.code));
      expect(notice.level).toBe(levels.get(notice.code));
      if (notice.code === 'usage_warning') expect(notice.params.pct).toBe(80);
      expect(notice.params.resets_at).toBe('2026-11-01T00:00:00.000Z');
    }
  });

  it('notifies the owner only, with ids and enums', async () => {
    const ctx = signalsWith();
    ctx.counters.set(ctx.ws, 4800);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    const [event] = ctx.notify.events;
    const claimedAt = [...ctx.store.rows.values()][0]?.claimedAt.getTime();
    expect(event).toEqual({
      category: 'usage_warning',
      recipients: { workspace: ctx.ws, roles: ['owner'] },
      params: { limit: 'hosted_minutes_month', pct: 80 },
      priority: 'normal',
      dedupeKey: `quota:${ctx.ws}:hosted_minutes_month:2026-10-01T00:00:00.000Z:warn:${String(claimedAt)}`,
      action: { type: 'open_billing' },
    });
    // B063 resolves the recipients against the workspace's members.
    const members: Record<string, WorkspaceRole> = {
      usr_owner: 'owner',
      usr_admin: 'admin',
      usr_member: 'member',
      usr_billing: 'billing',
      usr_guest: 'guest',
    };
    const directory = {
      workspaceMembers: (_ws: string, roles: WorkspaceRole[]) =>
        Promise.resolve(Object.keys(members).filter((u) => roles.includes(members[u] ?? 'guest'))),
      sessionMemberUsers: () => Promise.resolve([]),
      sessionUsersAmong: () => Promise.resolve([]),
      activeUsers: () => Promise.resolve([]),
    };
    if (event === undefined) throw new Error('no event');
    expect(await resolveRecipients(event, directory)).toEqual(['usr_owner']);
  });

  it('carries no use, limit size or text but the limit key, in notifications and webhooks', async () => {
    const ctx = signalsWith();
    ctx.entitlements.set(ctx.ws, { hosted_minutes_month: 6007, queue_items_month: 1009 });
    ctx.counters.set(ctx.ws, 6007, 1009);
    await ctx.signals.evaluateQuota(ctx.ws, NOW);
    const payloads = [
      ...ctx.notify.events.map((e) => e.params),
      ...ctx.webhooks.events.map((e) => e.data),
      ...ctx.notices.published.map((p) => p.notice.params),
    ];
    expect(payloads).toHaveLength(12);
    const text = JSON.stringify(payloads);
    expect(text).not.toMatch(/6007|1009/);
    for (const params of payloads) {
      for (const value of Object.values(params)) {
        expect(
          value === 80 ||
            value === 100 ||
            value === 'hosted_minutes_month' ||
            value === 'queue_items_month' ||
            value === '2026-11-01T00:00:00.000Z',
          String(value),
        ).toBe(true);
      }
    }
    expect(ctx.webhooks.events.map((e) => e.type)).toEqual(Array(4).fill('usage.threshold'));
  });
});
