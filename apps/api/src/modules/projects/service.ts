/**
 * Workspace projects (B035, CT-API-WORKSPACES): named references to a repository inside a
 * workspace.
 *
 * - **Create** (member+, the routes check): one transaction share-locks the workspace (404 when
 *   it was deleted meanwhile), inserts the project and audits it. A name the workspace already has,
 *   ignoring case, is a 409, also when two creates race.
 * - **Update** (member+): the row is locked, the ETag (`If-Match`, when given) checked (412 when
 *   stale), the fields changed and the version moved on, in one transaction; a taken name is a
 *   409.
 * - **Delete** (admin+): one transaction locks, deletes and audits.
 * - **Workspace purge:** `deleteForWorkspace` empties a deleted workspace (the `projects` hook of
 *   B027's purge job, registered by @centcom/worker `registerProjectPurgeHook`).
 *
 * CT-API-AUDIT's stable action names have no `project.*` yet, so changes are audited as
 * `workspace.update` with the project as the target and the touched fields in `fields`
 * (`project` for a create or delete). The server never reads a repository.
 *
 * Owns: the rules above. Must not: decide who may do what (B021's RBAC does, in the routes), or
 * log a name or a repository reference.
 */
import { newId } from '@centcom/contracts';
import {
  AppError,
  conflict,
  notFound,
  type Logger,
  type Page,
  type PageParams,
} from '@centcom/core';
import type { ProjectRecord, ProjectStore } from '@centcom/db';
import { ifMatchAccepts, type IfMatch } from '../me/etag.js';
import { WORKSPACE_DETAILS, type RequestCtx } from '../workspaces/service.js';
import type { ProjectInput, ProjectPatch } from './input.js';

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const PROJECT_DETAILS = Object.freeze({
  notFound: 'There is no such project.',
  nameTaken: 'The workspace already has a project with that name.',
  stale: 'The project changed since that ETag; read it again.',
} as const);

/** The `fields` an audit event gives a project's creation or deletion. */
export const PROJECT_AUDIT_FIELD = 'project';

/** Options for ProjectService. */
export interface ProjectServiceOptions {
  store: ProjectStore;
  /** Writes `project.*` lines (ids only). */
  logger?: Logger;
}

/** Projects. */
export class ProjectService {
  readonly #o: ProjectServiceOptions;

  constructor(options: ProjectServiceOptions) {
    this.#o = options;
  }

  /** One page of the workspace's projects, oldest first. */
  list(workspaceId: string, params: PageParams): Promise<Page<ProjectRecord>> {
    return this.#o.store.list(workspaceId, params);
  }

  /** The project of a live workspace, or null. */
  find(projectId: string): Promise<ProjectRecord | null> {
    return this.#o.store.findById(projectId);
  }

  /** Creates a project in `workspaceId` by `creatorId`. */
  async create(
    workspaceId: string,
    creatorId: string,
    input: ProjectInput,
    ctx: RequestCtx,
  ): Promise<ProjectRecord> {
    const id = newId('prj');
    const project = await this.#o.store.transaction(async (tx) => {
      if (!(await tx.lockLiveWorkspace(workspaceId))) throw notFound(WORKSPACE_DETAILS.notFound);
      const inserted = await tx.insert({
        id,
        workspaceId,
        name: input.name,
        repoRef: input.repoRef,
        createdBy: creatorId,
      });
      if (inserted === null) throw conflict(PROJECT_DETAILS.nameTaken);
      await ctx.audit(tx.trx, {
        action: 'workspace.update',
        workspaceId,
        target: { type: 'project', id },
        meta: { fields: PROJECT_AUDIT_FIELD },
      });
      return inserted;
    });
    this.#o.logger?.info({ project_id: id, workspace_id: workspaceId }, 'project.created');
    return project;
  }

  /**
   * Applies `patch` if `ifMatch` (when given) accepts the current version; returns the new record.
   * Throws 404 for a project that is gone, 412 for a stale ETag, 409 for a taken name.
   */
  async update(
    projectId: string,
    patch: ProjectPatch,
    ifMatch: IfMatch | undefined,
    ctx: RequestCtx,
  ): Promise<ProjectRecord> {
    return this.#o.store.transaction(async (tx) => {
      const current = await tx.lockById(projectId);
      if (current === null) throw notFound(PROJECT_DETAILS.notFound);
      if (!ifMatchAccepts(ifMatch, String(current.version))) {
        throw new AppError('precondition_failed', { detail: PROJECT_DETAILS.stale });
      }
      const updated = await tx.update(projectId, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.repoRef === undefined ? {} : { repoRef: patch.repoRef }),
      });
      if (updated === null) throw conflict(PROJECT_DETAILS.nameTaken);
      await ctx.audit(tx.trx, {
        action: 'workspace.update',
        workspaceId: current.workspaceId,
        target: { type: 'project', id: projectId },
        meta: { fields: patch.fields.join(',') },
      });
      return updated;
    });
  }

  /** Deletes the project (admin+: the routes check). Throws 404 for one that is gone. */
  async delete(projectId: string, ctx: RequestCtx): Promise<void> {
    const workspaceId = await this.#o.store.transaction(async (tx) => {
      const current = await tx.lockById(projectId);
      if (current === null) throw notFound(PROJECT_DETAILS.notFound);
      await tx.delete(projectId);
      await ctx.audit(tx.trx, {
        action: 'workspace.update',
        workspaceId: current.workspaceId,
        target: { type: 'project', id: projectId },
        meta: { fields: PROJECT_AUDIT_FIELD },
      });
      return current.workspaceId;
    });
    this.#o.logger?.info({ project_id: projectId, workspace_id: workspaceId }, 'project.deleted');
  }

  /** Deletes a deleted workspace's projects (B027's purge hook); returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number> {
    return this.#o.store.deleteForWorkspace(workspaceId);
  }
}
