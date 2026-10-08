/**
 * Test helpers for projects (B035): an in-memory ProjectStore over B027's in-memory workspace
 * state (one state, one transaction at a time, rollback on a throw, the case-insensitive unique
 * name per workspace, live-workspace-only reads), and the project and workspace routes on the
 * API's plugin stack, with a clock the tests move.
 */
import { randomUUID } from 'node:crypto';
import { paginateArray, type AuditDb } from '@centcom/core';
import type {
  NewProject,
  ProjectChanges,
  ProjectRecord,
  ProjectStore,
  ProjectTx,
} from '@centcom/db';
import type { FastifyInstance } from 'fastify';
import { ProjectService, projectRoutes } from '../../../src/modules/projects/index.js';
import {
  KEYS,
  MemoryWorkspaceStore,
  buildWorkspacesApp,
  type WorkspacesApp,
} from '../workspaces/helpers.js';

export { arrange } from '../members/helpers.js';
export { asKey, asUser } from '../workspaces/helpers.js';

/** When the tests start: 2026-10-07T12:00:00Z. */
export const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

/** B035's store over the in-memory workspace state. */
export class MemoryProjectStore implements ProjectStore {
  rows = new Map<string, ProjectRecord>();
  /** While set, transactions wait for it, counted in `waiting` (requests then truly race). */
  gate: Promise<void> | undefined;
  waiting = 0;

  constructor(
    readonly state: MemoryWorkspaceStore,
    /** Milliseconds, for `created_at` (the database's `now()`); each insert moves on 1 ms. */
    readonly clock: () => number,
  ) {}

  #tick = 0;

  #live(workspaceId: string): boolean {
    return this.state.workspaces.get(workspaceId)?.deletedAt === null;
  }

  #taken(workspaceId: string, name: string, except?: string): boolean {
    const key = name.toLowerCase();
    return [...this.rows.values()].some(
      (r) => r.workspaceId === workspaceId && r.id !== except && r.name.toLowerCase() === key,
    );
  }

  #tx(trx: AuditDb): ProjectTx {
    return {
      trx,
      lockLiveWorkspace: (workspaceId) => Promise.resolve(this.#live(workspaceId)),
      insert: (input: NewProject) => {
        if (this.#taken(input.workspaceId, input.name)) return Promise.resolve(null);
        this.#tick += 1;
        const at = new Date(this.clock() + this.#tick);
        const row: ProjectRecord = { ...input, version: 1, createdAt: at, updatedAt: at };
        this.rows.set(row.id, row);
        return Promise.resolve({ ...row });
      },
      lockById: (projectId) => {
        const row = this.rows.get(projectId);
        return Promise.resolve(
          row !== undefined && this.#live(row.workspaceId) ? { ...row } : null,
        );
      },
      update: (projectId, changes: ProjectChanges) => {
        const row = this.rows.get(projectId);
        if (row === undefined) throw new Error(`no project ${projectId}`);
        if (changes.name !== undefined && this.#taken(row.workspaceId, changes.name, projectId)) {
          return Promise.resolve(null);
        }
        if (changes.name !== undefined) row.name = changes.name;
        if (changes.repoRef !== undefined) row.repoRef = changes.repoRef;
        row.version += 1;
        row.updatedAt = new Date(this.clock());
        return Promise.resolve({ ...row });
      },
      delete: (projectId) => {
        this.rows.delete(projectId);
        return Promise.resolve();
      },
    };
  }

  async transaction<T>(fn: (tx: ProjectTx) => Promise<T>): Promise<T> {
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

  list(
    workspaceId: string,
    params: Parameters<ProjectStore['list']>[1],
  ): ReturnType<ProjectStore['list']> {
    const rows = this.#live(workspaceId)
      ? [...this.rows.values()].filter((r) => r.workspaceId === workspaceId).map((r) => ({ ...r }))
      : [];
    return Promise.resolve(
      paginateArray(
        rows,
        {
          sorts: { created: { value: (p) => p.createdAt.toISOString(), direction: 'asc' } },
          id: (p) => p.id,
        },
        params,
      ),
    );
  }

  findById(projectId: string): Promise<ProjectRecord | null> {
    const row = this.rows.get(projectId);
    return Promise.resolve(row !== undefined && this.#live(row.workspaceId) ? { ...row } : null);
  }

  deleteForWorkspace(workspaceId: string): Promise<number> {
    if (this.#live(workspaceId)) return Promise.resolve(0);
    const doomed = [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
    for (const r of doomed) this.rows.delete(r.id);
    return Promise.resolve(doomed.length);
  }
}

export interface ProjectsApp extends WorkspacesApp {
  projects: ProjectService;
  projectStore: MemoryProjectStore;
  /** The time, in milliseconds; tests move it. */
  clock: { now: number };
}

/** The project and workspace routes over one in-memory state. */
export async function projectsApp(): Promise<ProjectsApp> {
  const clock = { now: T0 };
  const read = (): number => clock.now;
  const state = new MemoryWorkspaceStore();
  const projectStore = new MemoryProjectStore(state, read);
  let projects: ProjectService | undefined;
  const app = await buildWorkspacesApp(state, state.reader, {
    clock: read,
    beforeReady: async (server, ctx) => {
      projects = new ProjectService({ store: projectStore, logger: ctx.captured.logger });
      await server.register(projectRoutes, { service: projects, cursorKeys: KEYS, clock: read });
    },
  });
  if (projects === undefined)
    throw new Error('projectsApp: the project routes were not registered');
  return { ...app, projects, projectStore, clock };
}

/** The headers of a user with both workspace scopes, and an Idempotency-Key when given. */
export const headersOf = (userId: string, idempotencyKey?: string): Record<string, string> => ({
  'x-test-user': userId,
  'x-test-scopes': 'workspaces:read workspaces:write',
  ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
});

/** A project created through the API, as it answered. */
export interface Created {
  status: number;
  body: Record<string, unknown>;
  id: string;
  etag: string | undefined;
  headers: Record<string, unknown>;
}

/** Creates a project in `workspaceId` as `userId` through the API. */
export async function createProject(
  app: FastifyInstance,
  workspaceId: string,
  userId: string,
  payload: Record<string, unknown> = { name: `Project ${randomUUID().slice(0, 8)}` },
  idempotencyKey?: string,
): Promise<Created> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/projects`,
    headers: headersOf(userId, idempotencyKey),
    payload,
  });
  const body = res.json<Record<string, unknown>>();
  const etag = res.headers['etag'];
  return {
    status: res.statusCode,
    body,
    id: String(body['id']),
    etag: typeof etag === 'string' ? etag : undefined,
    headers: res.headers,
  };
}
