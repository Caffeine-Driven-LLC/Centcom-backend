/**
 * Checking a notification event (B063, CT-NOTIF-PAYLOAD) before it is queued. `params` may hold
 * only the keys the category's allow-list names, each an id of its prefix, an enum value, a short
 * token (lower-case word, at most 64 characters) or an integer in range: never free text and
 * never anything from `ct`. A bad event is a NotificationEventError listing the problems by
 * pointer and code, never by value; nothing is queued or written.
 *
 * Owns: the allow-lists and the event check.
 */
import { isId, type IdPrefix } from '@centcom/contracts';
import {
  NOTIFICATION_ACTIONS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITIES,
  WORKSPACE_ROLES,
  type NotificationCategory,
  type NotificationEvent,
} from '@centcom/core';

/** One problem with an event: where, and what kind (never the value). */
export interface EventIssue {
  pointer: string;
  code: 'required' | 'invalid_value' | 'not_allowed' | 'too_many';
}

/** A notification event that may not be published. */
export class NotificationEventError extends Error {
  constructor(readonly issues: EventIssue[]) {
    super(`invalid notification event: ${issues.map((i) => `${i.pointer} ${i.code}`).join(', ')}`);
    this.name = 'NotificationEventError';
  }
}

/** How one param value is checked. */
type ParamRule =
  | { kind: 'id'; prefix: IdPrefix }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'token' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'version' };

const id = (prefix: IdPrefix): ParamRule => ({ kind: 'id', prefix });
const oneOf = (...values: string[]): ParamRule => ({ kind: 'enum', values });
const TOKEN: ParamRule = { kind: 'token' };
const int = (min: number, max: number): ParamRule => ({ kind: 'int', min, max });

/** Each category's params (CT-NOTIF-PAYLOAD "params keys per category"). */
export const PARAM_RULES: Readonly<
  Record<NotificationCategory, Readonly<Record<string, ParamRule>>>
> = Object.freeze({
  approval_needed: { agent: id('agt'), session: id('ses'), risk: oneOf('low', 'medium', 'high') },
  queue_turn: { session: id('ses'), item: id('que') },
  mention: { session: id('ses'), from: id('mem') },
  member_joined: { session: id('ses'), member: id('mem') },
  member_left: { session: id('ses'), member: id('mem') },
  agent_done: { session: id('ses'), agent: id('agt'), outcome: TOKEN },
  ci_failed: { session: id('ses'), agent: id('agt') },
  pr_merged: { session: id('ses'), agent: id('agt') },
  usage_warning: { limit: TOKEN, pct: int(0, 1000) },
  quota_reached: { limit: TOKEN },
  billing_issue: { kind: oneOf('payment_failed', 'card_expiring') },
  trial_ending: { days: int(0, 3650) },
  invite_received: { workspace: id('wsp') },
  update_available: { version: { kind: 'version' }, channel: TOKEN },
  security_alert: { kind: TOKEN },
});

/** A lower-case word: an enum value whose set the contract leaves open. */
const TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,32})?$/;
const DEDUPE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Recipients one event may name. */
export const MAX_EVENT_RECIPIENTS = 1000;
/** Longest action deeplink. */
const MAX_DEEPLINK = 2048;

function valueOk(rule: ParamRule, value: unknown): boolean {
  switch (rule.kind) {
    case 'id':
      return isId(rule.prefix, value);
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value);
    case 'token':
      return typeof value === 'string' && TOKEN_PATTERN.test(value);
    case 'int':
      return (
        Number.isSafeInteger(value) &&
        (value as number) >= rule.min &&
        (value as number) <= rule.max
      );
    case 'version':
      return typeof value === 'string' && VERSION_PATTERN.test(value);
  }
}

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

function recipientIssues(recipients: unknown): EventIssue[] {
  const r = recipients as Record<string, unknown> | null;
  if (typeof r !== 'object' || r === null) return [{ pointer: '/recipients', code: 'required' }];
  const listOf = (key: string, prefix: IdPrefix): EventIssue[] => {
    const list = r[key];
    if (!isList(list) || list.length === 0)
      return [{ pointer: `/recipients/${key}`, code: 'required' }];
    if (list.length > MAX_EVENT_RECIPIENTS)
      return [{ pointer: `/recipients/${key}`, code: 'too_many' }];
    return list.every((v) => isId(prefix, v))
      ? []
      : [{ pointer: `/recipients/${key}`, code: 'invalid_value' }];
  };
  if ('users' in r) return listOf('users', 'usr');
  if ('workspace' in r) {
    const issues: EventIssue[] = isId('wsp', r['workspace'])
      ? []
      : [{ pointer: '/recipients/workspace', code: 'invalid_value' }];
    const roles = r['roles'];
    if (!isList(roles) || roles.length === 0)
      issues.push({ pointer: '/recipients/roles', code: 'required' });
    else if (!roles.every((role) => (WORKSPACE_ROLES as readonly unknown[]).includes(role))) {
      issues.push({ pointer: '/recipients/roles', code: 'invalid_value' });
    }
    return issues;
  }
  if ('session' in r) {
    const issues: EventIssue[] = isId('ses', r['session'])
      ? []
      : [{ pointer: '/recipients/session', code: 'invalid_value' }];
    return [...issues, ...listOf('members', 'mem')];
  }
  return [{ pointer: '/recipients', code: 'invalid_value' }];
}

/** The problems with `event`; empty when it may be published. Never throws. */
export function eventIssues(event: unknown): EventIssue[] {
  const e = event as Partial<NotificationEvent> | null;
  if (typeof e !== 'object' || e === null) return [{ pointer: '', code: 'required' }];
  const issues: EventIssue[] = [];
  const category = e.category;
  if (!(NOTIFICATION_CATEGORIES as readonly unknown[]).includes(category)) {
    issues.push({ pointer: '/category', code: 'invalid_value' });
  }
  issues.push(...recipientIssues(e.recipients));
  const params = e.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    issues.push({ pointer: '/params', code: 'required' });
  } else if (issues.every((i) => i.pointer !== '/category')) {
    const rules = PARAM_RULES[category as NotificationCategory];
    for (const [key, value] of Object.entries(params)) {
      const rule = rules[key];
      if (rule === undefined) issues.push({ pointer: `/params/${key}`, code: 'not_allowed' });
      else if (!valueOk(rule, value))
        issues.push({ pointer: `/params/${key}`, code: 'invalid_value' });
    }
  }
  if (
    e.priority !== undefined &&
    !(NOTIFICATION_PRIORITIES as readonly unknown[]).includes(e.priority)
  ) {
    issues.push({ pointer: '/priority', code: 'invalid_value' });
  }
  if (
    e.dedupeKey !== undefined &&
    (typeof e.dedupeKey !== 'string' || !DEDUPE_PATTERN.test(e.dedupeKey))
  ) {
    issues.push({ pointer: '/dedupeKey', code: 'invalid_value' });
  }
  if (e.action !== undefined) {
    const action = e.action as { type?: unknown; deeplink?: unknown } | null;
    if (
      typeof action !== 'object' ||
      action === null ||
      !(NOTIFICATION_ACTIONS as readonly unknown[]).includes(action.type)
    ) {
      issues.push({ pointer: '/action/type', code: 'invalid_value' });
    } else if (
      action.deeplink !== undefined &&
      (typeof action.deeplink !== 'string' ||
        !action.deeplink.startsWith('centcom://') ||
        action.deeplink.length > MAX_DEEPLINK ||
        /[\s#]/.test(action.deeplink))
    ) {
      issues.push({ pointer: '/action/deeplink', code: 'invalid_value' });
    }
  }
  return issues;
}

/** Throws a NotificationEventError unless `event` may be published. */
export function checkEvent(event: unknown): asserts event is NotificationEvent {
  const issues = eventIssues(event);
  if (issues.length > 0) throw new NotificationEventError(issues);
}
