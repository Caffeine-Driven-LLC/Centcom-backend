/**
 * Test helpers for invites (B029): an in-memory InviteStore over B027's and B028's in-memory
 * stores (one state, one transaction at a time, rollback on a throw, the one-pending-invite
 * index), a seat gate double counting inside the transaction, invite links, and the invite, member
 * and workspace routes on the API's plugin stack, with B032's e-mail service queueing into a list
 * and a clock the tests move.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AppError,
  createEmailService,
  createMemoryRedis,
  paginateArray,
  type AuditDb,
  type EmailJobData,
  type EmailJobOptions,
} from '@centcom/core';
import type {
  InvitePreviewRow,
  InviteRecord,
  InviteRole,
  InviteStore,
  InviteTx,
  NewInvite,
} from '@centcom/db';
import { MembershipService, memberRoutes } from '../../../src/modules/members/index.js';
import {
  inviteRoutes,
  InviteService,
  type InviteUrlBuilder,
  type SeatGate,
} from '../../../src/modules/invites/index.js';
import { MemoryMemberStore } from '../members/helpers.js';
import {
  KEYS,
  MemoryWorkspaceStore,
  buildWorkspacesApp,
  type WorkspacesApp,
} from '../workspaces/helpers.js';

export { arrange } from '../members/helpers.js';
export { asKey, asUser } from '../workspaces/helpers.js';

/** An error as `pg` reports one. */
const pgError = (code: string): Error => Object.assign(new Error('database error'), { code });

/** An invite as the table holds it. */
export interface InviteRow {
  id: string;
  workspaceId: string;
  email: string | null;
  role: InviteRole;
  tokenHash: Buffer;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  expiredAt: Date | null;
  shareHistory: boolean;
  keyBundle: Buffer | null;
  keyBundleExpiresAt: Date | null;
  keyBundleFetchedAt: Date | null;
}

const isOpen = (row: InviteRow): boolean =>
  row.acceptedAt === null && row.revokedAt === null && row.expiredAt === null;

/** B029's store over the in-memory workspace and member state. */
export class MemoryInviteStore implements InviteStore {
  rows = new Map<string, InviteRow>();
  /** Who hosts a session of a workspace that has not ended. */
  readonly hosts: { workspaceId: string; userId: string }[] = [];
  /** While set, transactions wait for it, counted in `waiting` (requests then truly race). */
  gate: Promise<void> | undefined;
  waiting = 0;

  constructor(
    readonly state: MemoryWorkspaceStore,
    readonly memberStore: MemoryMemberStore,
    /** Milliseconds, for `created_at` (the database's `now()`). */
    readonly clock: () => number,
  ) {}

  #record(row: InviteRow): InviteRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      email: row.email,
      role: row.role,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      acceptedBy: row.acceptedBy,
      revokedAt: row.revokedAt,
      expiredAt: row.expiredAt,
      shareHistory: row.shareHistory,
      hasKeyBundle: row.keyBundle !== null,
      keyBundleFetchedAt: row.keyBundleFetchedAt,
    };
  }

  #byHash(tokenHash: Buffer): InviteRow | undefined {
    return [...this.rows.values()].find((r) => r.tokenHash.equals(tokenHash));
  }

  #tx(trx: AuditDb): InviteTx {
    const row = (id: string): InviteRow => {
      const found = this.rows.get(id);
      if (found === undefined) throw new Error(`no invite ${id}`);
      return found;
    };
    return {
      trx,
      members: this.memberStore.operations(trx),
      insert: (input: NewInvite) => {
        // invites_workspace_id_email_key: one pending invite per address per workspace.
        const pending = [...this.rows.values()].some(
          (r) =>
            input.email !== null &&
            r.workspaceId === input.workspaceId &&
            r.email === input.email &&
            isOpen(r),
        );
        if (pending) return Promise.resolve(null);
        if (this.#byHash(input.tokenHash) !== undefined) return Promise.reject(pgError('23505'));
        const created: InviteRow = {
          ...input,
          tokenHash: Buffer.from(input.tokenHash),
          createdAt: new Date(this.clock()),
          acceptedAt: null,
          acceptedBy: null,
          revokedAt: null,
          expiredAt: null,
          keyBundle: null,
          keyBundleExpiresAt: null,
          keyBundleFetchedAt: null,
        };
        this.rows.set(created.id, created);
        return Promise.resolve(this.#record(created));
      },
      expireLapsed: (workspaceId, email, now) => {
        for (const r of this.rows.values()) {
          const lapsed = r.expiresAt.getTime() <= now.getTime();
          if (r.workspaceId === workspaceId && r.email === email && isOpen(r) && lapsed) {
            Object.assign(r, { expiredAt: now, keyBundle: null, keyBundleExpiresAt: null });
          }
        }
        return Promise.resolve();
      },
      lockByToken: (tokenHash) => {
        const found = this.#byHash(tokenHash);
        return Promise.resolve(found === undefined ? null : this.#record(found));
      },
      lockById: (inviteId) => {
        const found = this.rows.get(inviteId);
        return Promise.resolve(found === undefined ? null : this.#record(found));
      },
      markAccepted: (inviteId, userId, at, bundleExpiresAt) => {
        const r = row(inviteId);
        r.acceptedAt = at;
        r.acceptedBy = userId;
        r.keyBundleExpiresAt = r.keyBundle === null ? null : bundleExpiresAt;
        return Promise.resolve();
      },
      markRevoked: (inviteId, at) => {
        Object.assign(row(inviteId), { revokedAt: at, keyBundle: null, keyBundleExpiresAt: null });
        return Promise.resolve();
      },
      putKeyBundle: (inviteId, bundle, expiresAt) => {
        Object.assign(row(inviteId), {
          keyBundle: Buffer.from(bundle),
          keyBundleExpiresAt: expiresAt,
        });
        return Promise.resolve();
      },
      takeKeyBundle: (inviteId, at) => {
        const r = this.rows.get(inviteId);
        if (r === undefined || r.keyBundle === null) return Promise.resolve(null);
        const bundle = r.keyBundle;
        const live = r.keyBundleExpiresAt !== null && r.keyBundleExpiresAt.getTime() > at.getTime();
        r.keyBundle = null;
        r.keyBundleExpiresAt = null;
        if (live) r.keyBundleFetchedAt = at;
        return Promise.resolve(live ? bundle : null);
      },
      hostsSessionIn: (workspaceId, userId) =>
        Promise.resolve(
          this.hosts.some((h) => h.workspaceId === workspaceId && h.userId === userId),
        ),
      emailOf: (userId) =>
        Promise.resolve(
          this.state.users.has(userId) ? (this.state.profiles.get(userId)?.email ?? null) : null,
        ),
      isMemberEmail: (workspaceId, email) =>
        Promise.resolve(
          this.state.memberships.some(
            (m) =>
              m.workspaceId === workspaceId && this.state.profiles.get(m.userId)?.email === email,
          ),
        ),
    };
  }

  async transaction<T>(fn: (tx: InviteTx) => Promise<T>): Promise<T> {
    if (this.gate !== undefined) {
      this.waiting += 1;
      await this.gate;
    }
    return this.state.exclusive(async (trx) => {
      const saved = new Map([...this.rows].map(([id, r]) => [id, { ...r }]));
      try {
        return await fn(this.#tx(trx));
      } catch (err) {
        this.rows = saved;
        throw err;
      }
    });
  }

  listPending(
    workspaceId: string,
    now: Date,
    params: Parameters<InviteStore['listPending']>[2],
  ): ReturnType<InviteStore['listPending']> {
    const pending = [...this.rows.values()]
      .filter(
        (r) => r.workspaceId === workspaceId && isOpen(r) && r.expiresAt.getTime() > now.getTime(),
      )
      .map((r) => this.#record(r));
    return Promise.resolve(
      paginateArray(
        pending,
        {
          sorts: { created: { value: (i) => i.createdAt.toISOString(), direction: 'asc' } },
          id: (i) => i.id,
        },
        params,
      ),
    );
  }

  findById(inviteId: string): Promise<InviteRecord | null> {
    const r = this.rows.get(inviteId);
    return Promise.resolve(r === undefined ? null : this.#record(r));
  }

  preview(tokenHash: Buffer): Promise<InvitePreviewRow | null> {
    const r = this.#byHash(tokenHash);
    const workspace = r === undefined ? undefined : this.state.workspaces.get(r.workspaceId);
    const inviter = r === undefined ? undefined : this.state.profiles.get(r.createdBy);
    if (r === undefined || workspace?.deletedAt !== null || inviter === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      invite: this.#record(r),
      workspaceName: workspace.name,
      inviterName: inviter.displayName,
    });
  }

  sweep(now: Date): Promise<{ expired: number; bundlesDropped: number }> {
    let expired = 0;
    let bundlesDropped = 0;
    for (const r of this.rows.values()) {
      if (isOpen(r) && r.expiresAt.getTime() <= now.getTime()) {
        Object.assign(r, { expiredAt: now, keyBundle: null, keyBundleExpiresAt: null });
        expired += 1;
      }
    }
    for (const r of this.rows.values()) {
      if (r.keyBundle !== null && (r.keyBundleExpiresAt?.getTime() ?? 0) <= now.getTime()) {
        Object.assign(r, { keyBundle: null, keyBundleExpiresAt: null });
        bundlesDropped += 1;
      }
    }
    return Promise.resolve({ expired, bundlesDropped });
  }

  deleteForWorkspace(workspaceId: string): Promise<number> {
    if (this.state.workspaces.get(workspaceId)?.deletedAt === null) return Promise.resolve(0);
    const doomed = [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
    for (const r of doomed) this.rows.delete(r.id);
    return Promise.resolve(doomed.length);
  }
}

/**
 * B030's seat gate, as a double: at most `seats` per workspace (default no limit), counting the
 * members and, with `countPendingInvites` (B030's usage), the pending invites, as the transaction
 * sees them; `deny` refuses everything with `entitlement_required`. Calls are recorded.
 */
export class SeatGateDouble implements SeatGate {
  seats = Number.POSITIVE_INFINITY;
  countPendingInvites = false;
  deny = false;
  readonly calls: { workspaceId: string; inTransaction: boolean }[] = [];

  constructor(
    readonly state: MemoryWorkspaceStore,
    readonly invites: MemoryInviteStore,
    readonly clock: () => number,
  ) {}

  /** The workspace's seats in use. */
  usage(workspaceId: string): number {
    const members = this.state.memberships.filter((m) => m.workspaceId === workspaceId).length;
    if (!this.countPendingInvites) return members;
    const pending = [...this.invites.rows.values()].filter(
      (r) => r.workspaceId === workspaceId && isOpen(r) && r.expiresAt.getTime() > this.clock(),
    ).length;
    return members + pending;
  }

  assertCanAdd(trx: AuditDb, workspaceId: string): Promise<void> {
    this.calls.push({ workspaceId, inTransaction: trx.isTransaction });
    if (this.deny) {
      return Promise.reject(
        new AppError('entitlement_required', { detail: 'The plan does not include this.' }),
      );
    }
    if (this.usage(workspaceId) >= this.seats) {
      return Promise.reject(new AppError('seat_limit_reached', { detail: 'No seat is free.' }));
    }
    return Promise.resolve();
  }
}

/** Invite links (B033's builder, as a double). */
export const URLS: InviteUrlBuilder = {
  inviteUrl: (token) => `https://app.centcom.test/i/${token}`,
  joinUrl: (token) => `centcom://join/${token}`,
};

/** When the tests start: 2026-10-07T12:00:00Z. */
export const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

export interface InvitesApp extends WorkspacesApp {
  invites: InviteService;
  inviteStore: MemoryInviteStore;
  memberStore: MemoryMemberStore;
  seats: SeatGateDouble;
  /** Emails queued through B032, with their job options. */
  mails: { data: EmailJobData; opts: EmailJobOptions }[];
  /** The time, in milliseconds; tests move it. */
  clock: { now: number };
}

export interface InvitesAppOptions {
  /** Registers B023's rate limiter. */
  rateLimit?: boolean;
  /** Leaves out the `seatGate` decorator (the invite routes must refuse to start). */
  withoutSeatGate?: boolean;
  /** Makes queueing an email fail (Redis or the queue down). */
  failMail?: boolean;
}

/** The invite, member and workspace routes over one in-memory state. */
export async function invitesApp(options: InvitesAppOptions = {}): Promise<InvitesApp> {
  const clock = { now: T0 };
  const read = (): number => clock.now;
  const state = new MemoryWorkspaceStore();
  const memberStore = new MemoryMemberStore(state);
  const inviteStore = new MemoryInviteStore(state, memberStore, read);
  const seats = new SeatGateDouble(state, inviteStore, read);
  const mails: InvitesApp['mails'] = [];
  let invites: InviteService | undefined;
  const app = await buildWorkspacesApp(state, state.reader, {
    clock: read,
    ...(options.rateLimit === true ? { rateLimit: true } : {}),
    beforeReady: async (server, ctx) => {
      const backend = createMemoryRedis();
      const email = createEmailService({
        queue: {
          add: (_name, data, opts) => {
            if (options.failMail === true) return Promise.reject(new Error('queue down'));
            mails.push({ data, opts });
            return Promise.resolve({ id: opts.jobId });
          },
        },
        rateLimit: backend.rateLimit,
        kv: backend.kv,
        from: 'Centcom <no-reply@centcom.test>',
      });
      const members = new MembershipService({
        store: memberStore,
        events: ctx.events,
        logger: ctx.captured.logger,
        metrics: ctx.recorded.metrics,
        sleep: () => Promise.resolve(),
      });
      invites = new InviteService({
        store: inviteStore,
        members,
        urls: URLS,
        email,
        clock: read,
        logger: ctx.captured.logger,
        metrics: ctx.recorded.metrics,
      });
      if (options.withoutSeatGate !== true) server.decorate('seatGate', seats);
      await server.register(memberRoutes, { members, workspaces: state, cursorKeys: KEYS });
      await server.register(inviteRoutes, {
        service: invites,
        workspaces: state,
        cursorKeys: KEYS,
        clock: read,
      });
    },
  });
  if (invites === undefined) throw new Error('invitesApp: the invite routes were not registered');
  return { ...app, invites, inviteStore, memberStore, seats, mails, clock };
}

/** A created invite, as the API answered. */
export interface Created {
  status: number;
  body: Record<string, unknown>;
  id: string;
  token: string;
}

/** Creates an invite in `workspaceId` as `userId` (an admin or the owner) through the API. */
export async function createInvite(
  t: InvitesApp,
  workspaceId: string,
  userId: string,
  payload: Record<string, unknown> = {},
  key: string = randomUUID(),
): Promise<Created> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/invites`,
    headers: {
      'x-test-user': userId,
      'x-test-scopes': 'workspaces:read workspaces:write',
      'idempotency-key': key,
    },
    payload,
  });
  const body = res.json<Record<string, unknown>>();
  return {
    status: res.statusCode,
    body,
    id: String(body['id']),
    token: String(body['token']),
  };
}

/** The headers of `userId` signed in with the `profile` scope (accepting, fetching bundles). */
export const asInvitee = (userId: string): Record<string, string> => ({
  'x-test-user': userId,
  'x-test-scopes': 'profile',
});

/** The headers of `userId` as a session host (`sessions:host`). */
export const asHost = (userId: string): Record<string, string> => ({
  'x-test-user': userId,
  'x-test-scopes': 'sessions:host',
});

/** A sealed-box-shaped key bundle: 48 bytes of overhead and `payload` random bytes. */
export const sealedBundle = (payload = 64): Buffer => randomBytes(48 + payload);

/** Adds a user with an address; returns their id. */
export function addUser(state: MemoryWorkspaceStore, email?: string): string {
  const userId = state.addUser();
  if (email !== undefined) {
    const profile = state.profiles.get(userId);
    if (profile !== undefined) profile.email = email;
  }
  return userId;
}
