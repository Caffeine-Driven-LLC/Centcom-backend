/**
 * Test helpers for workspace settings (B034): an in-memory WorkspaceSettingsStore with the
 * Postgres store's rules (changes take turns with B027's workspace transactions and roll back
 * when they throw), an entitlements reader stub on CT-ENTITLEMENTS' fixtures (`pro`: 7 days,
 * `team`: 30), and the settings routes plus the `settings` PATCH extension on B027's test app.
 */
import { readFileSync } from 'node:fs';
import type {
  WorkspaceSettingsRecord,
  WorkspaceSettingsStore,
  WorkspaceSettingsTx,
  WorkspaceStore,
} from '@centcom/db';
import type { AuditDb } from '@centcom/core';
import type { MembershipReader } from '@centcom/core';
import {
  WorkspaceSettingsService,
  workspaceSettingsRoutes,
  type HistoryDaysReader,
} from '../../../src/modules/workspace-settings/index.js';
import {
  buildWorkspacesApp,
  MemoryWorkspaceStore,
  type WorkspacesApp,
  type WorkspacesAppOptions,
} from '../workspaces/helpers.js';

/** Settings in memory, over B027's in-memory workspaces. */
export class MemorySettingsStore implements WorkspaceSettingsStore {
  rows = new Map<string, WorkspaceSettingsRecord>();

  constructor(readonly workspaces: MemoryWorkspaceStore) {}

  transaction<T>(fn: (tx: WorkspaceSettingsTx) => Promise<T>): Promise<T> {
    return this.workspaces.exclusive(async (trx) => {
      const saved = new Map(this.rows);
      try {
        return await fn(this.within(trx));
      } catch (err) {
        this.rows = saved;
        throw err;
      }
    });
  }

  within(trx: AuditDb): WorkspaceSettingsTx {
    return {
      trx,
      lockWorkspace: (workspaceId) =>
        Promise.resolve(this.workspaces.workspaces.get(workspaceId)?.deletedAt === null),
      read: (workspaceId) => Promise.resolve(this.#copy(this.rows.get(workspaceId))),
      write: (workspaceId, values, version) => {
        this.rows.set(workspaceId, { ...values, version });
        return Promise.resolve();
      },
    };
  }

  get(workspaceId: string): Promise<WorkspaceSettingsRecord | null> {
    return Promise.resolve(this.#copy(this.rows.get(workspaceId)));
  }

  deleteForWorkspace(workspaceId: string): Promise<number> {
    const deleted = this.workspaces.workspaces.get(workspaceId)?.deletedAt != null;
    if (!deleted || !this.rows.has(workspaceId)) return Promise.resolve(0);
    this.rows.delete(workspaceId);
    return Promise.resolve(1);
  }

  #copy(row: WorkspaceSettingsRecord | undefined): WorkspaceSettingsRecord | null {
    return row === undefined ? null : { ...row };
  }
}

/** `history_days` of a CT-ENTITLEMENTS fixture (`contracts/fixtures/entitlements/<plan>.json`). */
export function fixtureHistoryDays(plan: 'free' | 'pro' | 'team'): number {
  const url = new URL(
    `../../../../../contracts/fixtures/entitlements/${plan}.json`,
    import.meta.url,
  );
  const fixture = JSON.parse(readFileSync(url, 'utf8')) as {
    data: { limits: { history_days: number } };
  };
  return fixture.data.limits.history_days;
}

/** An entitlements reader stub: one plan's `history_days` for every workspace, or a failure. */
export interface EntitlementsStub extends HistoryDaysReader {
  plan: 'free' | 'pro' | 'team';
  /** When set, every read rejects (billing down). */
  fail: boolean;
  /** Workspaces asked about. */
  asked: string[];
}

export function entitlementsStub(plan: EntitlementsStub['plan'] = 'pro'): EntitlementsStub {
  const stub: EntitlementsStub = {
    plan,
    fail: false,
    asked: [],
    historyDays(workspaceId) {
      stub.asked.push(workspaceId);
      if (stub.fail) return Promise.reject(new Error('entitlements unavailable'));
      return Promise.resolve(fixtureHistoryDays(stub.plan));
    },
  };
  return stub;
}

/** The test app with settings. */
export interface SettingsApp<
  S extends WorkspaceStore = MemoryWorkspaceStore,
> extends WorkspacesApp<S> {
  settings: WorkspaceSettingsService;
  settingsStore: WorkspaceSettingsStore;
  entitlements: EntitlementsStub;
  /** Waits asked for between announcement attempts. */
  sleeps: number[];
}

/** Options of the settings test app. */
export interface SettingsAppOptions extends WorkspacesAppOptions {
  plan?: EntitlementsStub['plan'];
}

/** The workspace and settings routes, with the `settings` extension, over `store`. */
export async function buildSettingsApp<S extends WorkspaceStore>(
  store: S,
  reader: MembershipReader,
  settingsStore: WorkspaceSettingsStore,
  options: SettingsAppOptions = {},
): Promise<SettingsApp<S>> {
  const entitlements = entitlementsStub(options.plan ?? 'pro');
  const sleeps: number[] = [];
  let settings: WorkspaceSettingsService | undefined;
  const t = await buildWorkspacesApp(store, reader, {
    ...options,
    beforeReady: async (server, ctx) => {
      settings = new WorkspaceSettingsService({
        store: settingsStore,
        entitlements,
        events: ctx.events,
        clock: () => Date.UTC(2026, 9, 7, 12, 0, 0),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        logger: ctx.captured.logger,
        metrics: ctx.recorded.metrics,
      });
      await server.register(workspaceSettingsRoutes, { service: settings });
      await options.beforeReady?.(server, ctx);
    },
  });
  if (settings === undefined) throw new Error('buildSettingsApp: settings were not registered');
  t.extensions.register(settings.patchExtension());
  return { ...t, settings, settingsStore, entitlements, sleeps };
}

/** The settings app over fresh in-memory stores. */
export function settingsApp(options: SettingsAppOptions = {}): Promise<SettingsApp> {
  const store = new MemoryWorkspaceStore();
  return buildSettingsApp(store, store.reader, new MemorySettingsStore(store), options);
}

/** The audit rows of committed transactions with action `workspace.update`, meta parsed. */
export function updateEvents(store: MemoryWorkspaceStore): Record<string, unknown>[] {
  return store.audit
    .filter((row) => row['action'] === 'workspace.update')
    .map((row) => ({
      ...row,
      meta: typeof row['meta'] === 'string' ? (JSON.parse(row['meta']) as unknown) : row['meta'],
    }));
}

/** The `workspace.settings_changed` messages published. */
export function settingsMessages(t: SettingsApp<WorkspaceStore>): Record<string, unknown>[] {
  return t.published
    .filter((p) => p.channel === 'centcom:workspace-events')
    .map((p) => JSON.parse(p.message) as Record<string, unknown>)
    .filter((m) => m['type'] === 'workspace.settings_changed');
}
