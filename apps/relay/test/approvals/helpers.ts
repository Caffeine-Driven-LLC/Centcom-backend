/**
 * Test helpers for approval routing (B060): `approval.*` frames built from
 * `contracts/fixtures/events/approval.*.json` with fresh ids, a router over the Redis store on
 * B009's in-memory Redis (one fake clock for both), a sequencer that numbers frames and
 * de-duplicates by `(from, id)` as B041 does, a membership fake with session and workspace roles,
 * an agent registry fake, and recorders for notifications, timeout denies and audit events.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { createMemoryRedis, type KeyValue } from '@centcom/core';
import type {
  ApprovalFrame,
  ApprovalNotice,
  ApprovalSender,
  Approver,
  Decider,
  Risk,
} from '../../src/approvals/ports.js';
import { ApprovalRouter, type ApprovalRouterDeps } from '../../src/approvals/router.js';
import { createRedisApprovalStore } from '../../src/approvals/store.js';
import type { SessionRole } from '../../src/rooms/kind-policy.js';
import type { StoredFrame } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

/** The fixture frame of `kind`. */
export function fixture(kind: 'approval.request' | 'approval.decision'): Record<string, unknown> {
  const url = new URL(`../../../../contracts/fixtures/events/${kind}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { frame: Record<string, unknown> }).frame;
}

/** A member of the test session. */
export interface TestMember extends ApprovalSender {
  userId: string;
  workspaceRole: string;
}

/** The router, its fakes and recorders, and a session with members of every role. */
export function approvalEnv(overrides: Partial<ApprovalRouterDeps> = {}) {
  const clock = { now: Date.parse('2026-10-10T12:00:00.000Z') };
  const redis = createMemoryRedis(() => clock.now);
  const written: { key: string; value: string }[] = [];
  const down = { on: false };
  const kv: Pick<KeyValue, 'get' | 'set' | 'setIfAbsent' | 'del'> = {
    get: (k) => (down.on ? Promise.reject(new Error('redis down')) : redis.kv.get(k)),
    set: (k, v, o) => {
      if (down.on) return Promise.reject(new Error('redis down'));
      written.push({ key: k, value: v });
      return redis.kv.set(k, v, o);
    },
    setIfAbsent: (k, v, ttl) => {
      if (down.on) return Promise.reject(new Error('redis down'));
      written.push({ key: k, value: v });
      return redis.kv.setIfAbsent(k, v, ttl);
    },
    del: (k) => (down.on ? Promise.reject(new Error('redis down')) : redis.kv.del(k)),
  };
  const sid = newId('ses');
  const workspaceId = newId('wsp');
  const member = (role: SessionRole, workspaceRole = 'member'): TestMember => ({
    memberId: newId('mem'),
    role,
    userId: newId('usr'),
    workspaceRole,
  });
  const host = member('host', 'owner');
  const editor = member('editor');
  const other = member('editor');
  const admin = member('editor', 'admin');
  const owner = member('editor', 'owner');
  const viewer = member('viewer');
  const members = new Map<string, TestMember>(
    [host, editor, other, admin, owner, viewer].map((m) => [m.memberId, m]),
  );
  /** Members the session's policy lists as approvers. */
  const approvers: string[] = [];
  /** Agent to owning member. */
  const agents = new Map<string, string>();
  const notified: ({ sid: string } & ApprovalNotice)[] = [];
  const timeouts: { sid: string; approvalId: string }[] = [];
  const audited: Record<string, unknown>[] = [];
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const deps: ApprovalRouterDeps = {
    store: createRedisApprovalStore({ kv, clock: () => clock.now }),
    deciders: {
      get(_sid, mid) {
        const m = members.get(mid);
        if (m === undefined) return Promise.resolve(null);
        const d: Decider = {
          role: m.role,
          userId: m.userId,
          workspaceId,
          workspaceRole: m.workspaceRole,
        };
        return Promise.resolve(d);
      },
      approvers: () => Promise.resolve([...approvers]),
    },
    agents: { ownerOf: (_sid, agentId) => Promise.resolve(agents.get(agentId)) },
    notify: {
      approvalNeeded(s, a) {
        notified.push({ sid: s, ...a });
      },
    },
    emitter: {
      emitTimeout(s, approvalId) {
        timeouts.push({ sid: s, approvalId });
        return Promise.resolve();
      },
    },
    audit: {
      emitDetached: (event) => void audited.push(event as unknown as Record<string, unknown>),
    },
    clock: () => clock.now,
    logger: captured.logger,
    metrics: recorded.metrics,
    ...overrides,
  };
  const router = new ApprovalRouter(deps);
  router.watch(sid);
  const seen = new Map<string, number>();
  let head = 0;
  const sequenced: { frame: ApprovalFrame & { k: string }; from: string; seq: number }[] = [];
  /** Frames B041 acked again as duplicates (sender and frame id). */
  const reacked: string[] = [];
  /**
   * Frame ids whose next sequencing stores the frame, then reports the store failure (B041's
   * `unavailable` with SEQUENCE_UNKNOWN_KEY: the outcome is unknown).
   */
  const loseOutcome = new Set<string>();
  /** Frame ids whose next sequencing fails in the store before writing (also `unknown`). */
  const failUnknown = new Set<string>();
  /**
   * Sequences as B041 does (seq/stage.ts): a frame gets the next seq after a few ticks (its trip to
   * Redis); a resend (same sender and id) is acked again and reported as a duplicate with its
   * original place (SEQUENCED_DUPLICATE_KEY), not as newly sequenced.
   */
  const sequencer = (k: string, frame: ApprovalFrame, by: ApprovalSender) => async () => {
    const key = `${by.memberId}:${frame.id}`;
    for (let i = 0; i < 3; i++) await Promise.resolve();
    const ts = new Date(clock.now).toISOString();
    if (failUnknown.delete(frame.id)) return 'unknown' as const;
    const prior = seen.get(key);
    if (prior !== undefined) {
      reacked.push(key);
      return { frame: { seq: prior, ts } as StoredFrame, duplicate: true };
    }
    const seq = ++head;
    seen.set(key, seq);
    sequenced.push({ frame: { k, ...frame }, from: by.memberId, seq });
    if (loseOutcome.delete(frame.id)) return 'unknown' as const;
    return { frame: { seq, ts } as StoredFrame, duplicate: false };
  };
  const ctx = (k: string, frame: ApprovalFrame, by: ApprovalSender) => ({
    sid,
    sender: { memberId: by.memberId, role: by.role },
    sequence: sequencer(k, frame, by),
  });
  /** Sends an `approval.request` from `by`. */
  const request = (frame: ApprovalFrame, by: ApprovalSender) =>
    router.onRequest(ctx('approval.request', frame, by), frame);
  /** Sends an `approval.decision` from `by`. */
  const decide = (frame: ApprovalFrame, by: ApprovalSender) =>
    router.onDecision(ctx('approval.decision', frame, by), frame);
  /** An agent owned by `owner`. */
  const agentOf = (owner: ApprovalSender): string => {
    const id = newId('agt');
    agents.set(id, owner.memberId);
    return id;
  };
  return {
    clock,
    redis,
    kv,
    down,
    written,
    sid,
    host,
    editor,
    other,
    admin,
    owner,
    viewer,
    members,
    approvers,
    agents,
    notified,
    timeouts,
    audited,
    captured,
    recorded,
    deps,
    router,
    sequenced,
    reacked,
    loseOutcome,
    failUnknown,
    request,
    decide,
    agentOf,
  };
}

/** An `approval.request` frame (fixture shape, fresh ids; `ct` stays opaque and is never routed). */
export function requestFrame(p: {
  agent: string;
  approval?: string;
  risk?: Risk;
  approver?: Approver;
  expiresAt: number | string;
}): ApprovalFrame & { approvalId: string } {
  const base = fixture('approval.request');
  const approvalId = p.approval ?? newId('apr');
  return {
    id: newId('msg'),
    p: {
      ...(base['p'] as Record<string, unknown>),
      approval_id: approvalId,
      agent_id: p.agent,
      risk: p.risk ?? 'medium',
      approver: p.approver ?? 'host',
      expires_at:
        typeof p.expiresAt === 'number' ? new Date(p.expiresAt).toISOString() : p.expiresAt,
    },
    approvalId,
  };
}

/** An `approval.decision` frame. */
export function decisionFrame(
  approvalId: string,
  decision: 'approve' | 'deny' = 'approve',
  scope: 'once' | 'session' | 'always' = 'once',
): ApprovalFrame {
  return { id: newId('msg'), p: { approval_id: approvalId, decision, scope } };
}

/** Ten minutes after `now`. */
export const inTenMinutes = (now: number): number => now + 600_000;
