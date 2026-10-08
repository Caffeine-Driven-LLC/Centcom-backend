/**
 * Workspaces (B027, CT-API-WORKSPACES): create, read, list, update and delete.
 *
 * - **Create:** one transaction inserts the workspace and the caller's `owner` membership and
 *   writes `workspace.create`. The slug is the caller's (a taken one is a 409) or made from the
 *   name, with the next free numeric suffix; a slug race retries with a new suffix up to 5 times,
 *   then 409. One user owns at most WORKSPACES_MAX_OWNED live workspaces (409 beyond).
 * - **Update:** the row is locked, the ETag (`If-Match`) checked (412 when stale), then the name
 *   and the extensions' fields change, the version moves on and `workspace.update` is written,
 *   all in one transaction: of two updates with one ETag, exactly one wins. The steps extensions
 *   return run after the commit.
 * - **Delete:** one transaction hides the workspace (every read is a 404 from then on) and writes
 *   `workspace.delete` as an account-level event, so the record outlives the purge. After the
 *   commit, `workspace.deleted` is announced on Redis, cached roles are dropped, and the
 *   `workspace-purge` job is queued; their failures are logged and counted (the purge job
 *   announces again first).
 *
 * Owns: the rules above. Must not: decide who may do what (B021's RBAC does, in the routes), or
 * return a deleted workspace.
 */
import {
  AppError,
  conflict,
  noopMetrics,
  notFound,
  publishInvalidation,
  publishWorkspaceDeleted,
  unauthorized,
  WORKSPACE_PURGE_QUEUE,
  workspacePurgeJobId,
  workspacePurgeJobOptions,
  type AuditDb,
  type Logger,
  type Metrics,
  type Page,
  type PageParams,
  type PubSub,
  type WorkspacePurgeJobData,
} from '@centcom/core';
import { newId as makeId } from '@centcom/contracts';
import type { WorkspaceRecord, WorkspaceStore, WorkspaceView } from '@centcom/db';
import type { AuditInput } from '../../plugins/audit.js';
import { ifMatchAccepts, type IfMatch } from '../me/etag.js';
import {
  createPatchExtensionRegistry,
  type CreateInput,
  type PatchExtensionRegistry,
  type UpdateInput,
} from './input.js';
import { nextSlug, slugFromName } from './slug.js';

/** Slugs tried before a create gives up with 409. */
export const SLUG_ATTEMPTS = 5;

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const WORKSPACE_DETAILS = Object.freeze({
  notFound: 'There is no such workspace.',
  stale: 'The workspace changed since that ETag; read it again.',
  slugTaken: 'That slug is taken.',
  slugExhausted: 'No free slug could be found for that name; choose a slug.',
  ownedLimit: 'You own as many workspaces as allowed; delete one first.',
  noAccount: 'There is no such account.',
} as const);

/** What a request lends the service: writing audit events in a transaction (`request.audit`). */
export interface RequestCtx {
  audit(trx: AuditDb, input: AuditInput): Promise<string>;
}

/** Who reads: a user (through their membership) or an API key (of one workspace). */
export type Reader = { kind: 'user'; userId: string } | { kind: 'api_key'; workspaceId: string };

/** Where purges are queued: a BullMQ `workspace-purge` queue (@centcom/worker `createWorkspacePurgeQueue`). */
export interface PurgeQueue {
  add(
    name: string,
    data: WorkspacePurgeJobData,
    opts: ReturnType<typeof workspacePurgeJobOptions> & { jobId: string },
  ): Promise<unknown>;
}

/** Options for WorkspaceService. */
export interface WorkspaceServiceOptions {
  store: WorkspaceStore;
  /** Announces deletions and drops cached roles (B009 `RedisBackend.pubsub`). */
  events: PubSub;
  purgeQueue: PurgeQueue;
  /** WORKSPACES_MAX_OWNED. */
  maxOwned: number;
  /** The PATCH extensions; default an empty registry. */
  extensions?: PatchExtensionRegistry;
  /** Makes `wsp_` and `mem_` ids; default CT-IDS `newId`. */
  newId?: (prefix: 'wsp' | 'mem') => string;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Writes `workspace.*` lines (ids only). */
  logger?: Logger;
  /**
   * Receives `workspaces_created_total`, `workspaces_deleted_total`,
   * `workspace_announce_failures_total` and `workspace_purge_enqueue_failures_total`.
   */
  metrics?: Metrics;
}

/** Workspace CRUD. */
export class WorkspaceService {
  readonly #o: WorkspaceServiceOptions;
  readonly #newId: (prefix: 'wsp' | 'mem') => string;
  readonly #clock: () => number;
  readonly #metrics: Metrics;
  readonly extensions: PatchExtensionRegistry;

  constructor(options: WorkspaceServiceOptions) {
    this.#o = options;
    this.#newId = options.newId ?? ((prefix) => makeId(prefix));
    this.#clock = options.clock ?? Date.now;
    this.#metrics = options.metrics ?? noopMetrics;
    this.extensions = options.extensions ?? createPatchExtensionRegistry();
  }

  /** Creates a workspace owned by `userId`. */
  async create(userId: string, input: CreateInput, ctx: RequestCtx): Promise<WorkspaceView> {
    const id = this.#newId('wsp');
    const membershipId = this.#newId('mem');
    const base = input.slug ?? slugFromName(input.name);
    const record = await this.#o.store.transaction(async (tx) => {
      // Locking the user makes one user's creates take turns, so the owned count holds.
      if (!(await tx.lockUser(userId))) throw unauthorized(WORKSPACE_DETAILS.noAccount);
      if ((await tx.countOwned(userId)) >= this.#o.maxOwned) {
        throw conflict(WORKSPACE_DETAILS.ownedLimit);
      }
      let created: WorkspaceRecord | null = null;
      for (let attempt = 0; attempt < SLUG_ATTEMPTS && created === null; attempt++) {
        const slug = input.slug ?? nextSlug(base, await tx.slugsLike(base));
        created = await tx.insert({ id, name: input.name, slug, ownerId: userId, membershipId });
        if (created === null && input.slug !== undefined)
          throw conflict(WORKSPACE_DETAILS.slugTaken);
      }
      if (created === null) throw conflict(WORKSPACE_DETAILS.slugExhausted);
      await ctx.audit(tx.trx, {
        action: 'workspace.create',
        workspaceId: id,
        target: { type: 'workspace', id },
      });
      return created;
    });
    this.#metrics.counter('workspaces_created_total').inc();
    this.#o.logger?.info({ workspace_id: id, user_id: userId }, 'workspace.created');
    return { ...record, role: 'owner', ownerId: userId, memberCount: 1 };
  }

  /** The live workspace as `reader` sees it, or null. */
  get(workspaceId: string, reader: Reader): Promise<WorkspaceView | null> {
    if (reader.kind === 'user') return this.#o.store.findForMember(workspaceId, reader.userId);
    return reader.workspaceId === workspaceId
      ? this.#o.store.findLive(workspaceId)
      : Promise.resolve(null);
  }

  /** One page of `reader`'s workspaces (an API key's is its own). */
  async list(reader: Reader, params: PageParams): Promise<Page<WorkspaceView>> {
    if (reader.kind === 'user') return this.#o.store.listForMember(reader.userId, params);
    const own = await this.#o.store.findLive(reader.workspaceId);
    return { data: own === null ? [] : [own], next_cursor: null, has_more: false };
  }

  /**
   * Applies `update` if `ifMatch` accepts the current version; returns the new record. Throws 404
   * for a workspace that is gone, 412 for a stale ETag.
   */
  async update(
    workspaceId: string,
    update: UpdateInput,
    ifMatch: IfMatch,
    ctx: RequestCtx,
  ): Promise<WorkspaceRecord> {
    let afterCommit: (() => Promise<void>)[] = [];
    const record = await this.#o.store.transaction(async (tx) => {
      afterCommit = [];
      const current = await tx.lockLive(workspaceId);
      if (current === null) throw notFound(WORKSPACE_DETAILS.notFound);
      if (!ifMatchAccepts(ifMatch, String(current.version))) {
        throw new AppError('precondition_failed', { detail: WORKSPACE_DETAILS.stale });
      }
      const updated = await tx.update(
        workspaceId,
        update.name === undefined ? {} : { name: update.name },
      );
      for (const { extension, value } of update.extensions) {
        const then = await extension.apply(tx, workspaceId, value, ctx);
        if (typeof then === 'function') afterCommit.push(then);
      }
      await ctx.audit(tx.trx, {
        action: 'workspace.update',
        target: { type: 'workspace', id: workspaceId },
        meta: { fields: update.fields.join(',') },
      });
      return updated;
    });
    // The extensions' announcements, once the change is committed.
    for (const step of afterCommit) await step();
    return record;
  }

  /**
   * Deletes the workspace (owner only: the routes check). Throws 404 for one that is gone, 412 for
   * a stale `If-Match`. Announcing and queueing the purge happen after the commit.
   */
  async softDelete(
    workspaceId: string,
    ifMatch: IfMatch | undefined,
    ctx: RequestCtx,
  ): Promise<void> {
    await this.#o.store.transaction(async (tx) => {
      const current = await tx.lockLive(workspaceId);
      if (current === null) throw notFound(WORKSPACE_DETAILS.notFound);
      if (!ifMatchAccepts(ifMatch, String(current.version))) {
        throw new AppError('precondition_failed', { detail: WORKSPACE_DETAILS.stale });
      }
      await tx.softDelete(workspaceId);
      // Account-level, naming the workspace: its own audit events go with the purge, this stays.
      await ctx.audit(tx.trx, {
        action: 'workspace.delete',
        workspaceId: null,
        target: { type: 'workspace', id: workspaceId },
      });
    });
    this.#metrics.counter('workspaces_deleted_total').inc();
    this.#o.logger?.info({ workspace_id: workspaceId }, 'workspace.deleted');
    const at = new Date(this.#clock());
    try {
      await publishWorkspaceDeleted(this.#o.events, workspaceId, at);
      await publishInvalidation(this.#o.events, { workspaceId });
    } catch {
      this.#metrics.counter('workspace_announce_failures_total').inc();
      this.#o.logger?.error({ workspace_id: workspaceId }, 'workspace.announce_failed');
    }
    try {
      await this.#o.purgeQueue.add(
        WORKSPACE_PURGE_QUEUE,
        { workspaceId },
        { ...workspacePurgeJobOptions(), jobId: workspacePurgeJobId(workspaceId) },
      );
    } catch {
      this.#metrics.counter('workspace_purge_enqueue_failures_total').inc();
      this.#o.logger?.error({ workspace_id: workspaceId }, 'workspace.purge_enqueue_failed');
    }
  }
}
