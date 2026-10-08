/**
 * Workspace settings (B034, CT-API-WORKSPACES): a workspace's default auto-approve level, history
 * sharing and retention override.
 *
 * - **Read:** the stored settings, or the defaults (`ask`, true, null) with ETag `"s0"` while the
 *   workspace has none.
 * - **Change** (`/settings`, or the `settings` field of a workspace PATCH, through one code
 *   path): in one transaction, the workspace row is locked, the settings' ETag checked (412 when
 *   stale; a workspace PATCH checked the workspace's instead), a retention override checked
 *   against the plan's `history_days` (422 above it, 503 when entitlements are unavailable), the
 *   row written with the next version (the first change creates it), and `workspace.update`
 *   audited with the changed keys and their old and new values. A change that changes nothing
 *   writes nothing.
 * - **Announce:** after the commit, `workspace.settings_changed` with the changed keys goes out on
 *   `centcom:workspace-events`, tried up to 4 times; a failure is logged and counted, and the
 *   stored value stands.
 *
 * Settings are defaults only: the server never pushes them into a live session (the host client
 * applies them through `control.policy`).
 *
 * Owns: the rules above. Must not: decide who may do what (B021's RBAC does, in the routes), let
 * a retention override exceed `history_days`, or put anything but keys, enums, flags and counts
 * into an audit event or a message.
 */
import {
  AppError,
  noopMetrics,
  notFound,
  publishWorkspaceSettingsChanged,
  unavailable,
  validationFailed,
  type AuditMetaValue,
  type Logger,
  type Metrics,
  type PubSub,
} from '@centcom/core';
import type {
  WorkspaceSettingsRecord,
  WorkspaceSettingsStore,
  WorkspaceSettingsTx,
} from '@centcom/db';
import { ifMatchAccepts, type IfMatch } from '../me/etag.js';
import type { PatchExtension, RequestCtx } from '../workspaces/index.js';
import type { HistoryDaysReader } from './entitlements.js';
import { settingsEtag } from './etag.js';
import {
  checkSettingsPatch,
  INVALID_SETTINGS_DETAIL,
  SETTINGS_KEYS,
  type SettingsKey,
  type SettingsPatch,
  type WorkspaceSettings,
} from './input.js';

/** The settings of a workspace that never changed them. */
export const DEFAULT_WORKSPACE_SETTINGS: Readonly<WorkspaceSettings> = Object.freeze({
  auto_approve: 'ask',
  share_history: true,
  history_retention_days: null,
});

/** Announcements are tried this many times in all (the first and 3 retries). */
export const SETTINGS_PUBLISH_ATTEMPTS = 4;
/** Wait before the first retry, in milliseconds; each later one waits twice as long. */
export const SETTINGS_PUBLISH_BACKOFF_MS = 100;

/** The user-facing details of this module's problems (GUIDELINES §3.4: one message table). */
export const SETTINGS_DETAILS = Object.freeze({
  notFound: 'There is no such workspace.',
  stale: 'The settings changed since that ETag; read them again.',
  overCap: "must not exceed the plan's history_days",
  entitlements: 'The plan cannot be checked right now; try again.',
} as const);

/** Settings as a route answers with them. */
export interface SettingsView {
  settings: WorkspaceSettings;
  /** `"s<version>"`. */
  etag: string;
  version: number;
}

/** Options for WorkspaceSettingsService. */
export interface WorkspaceSettingsServiceOptions {
  store: WorkspaceSettingsStore;
  /** The plan's `history_days` (B069's reader; `freePlanHistoryDays` until it exists). */
  entitlements: HistoryDaysReader;
  /** Announces changes (B009 `RedisBackend.pubsub`). */
  events: Pick<PubSub, 'publish'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Waits between announcement attempts; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Writes `workspace.settings_*` lines (ids and keys only). */
  logger?: Logger;
  /** Receives `workspace_settings_changed_total` and `workspace_settings_publish_failures_total`. */
  metrics?: Metrics;
}

const AUDIT_NAMES: Record<SettingsKey, string> = {
  auto_approve: 'auto_approve',
  share_history: 'share_history',
  history_retention_days: 'retention_days',
};

const toSettings = (record: WorkspaceSettingsRecord | null): WorkspaceSettings =>
  record === null
    ? { ...DEFAULT_WORKSPACE_SETTINGS }
    : {
        auto_approve: record.autoApprove,
        share_history: record.shareHistory,
        history_retention_days: record.retentionDays,
      };

const view = (settings: WorkspaceSettings, version: number): SettingsView => ({
  settings,
  etag: settingsEtag(version),
  version,
});

/** Workspace settings. */
export class WorkspaceSettingsService {
  readonly #o: WorkspaceSettingsServiceOptions;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #metrics: Metrics;

  constructor(options: WorkspaceSettingsServiceOptions) {
    this.#o = options;
    this.#clock = options.clock ?? Date.now;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.#metrics = options.metrics ?? noopMetrics;
  }

  /** The workspace's settings (the caller checked it may read them). */
  async get(workspaceId: string): Promise<SettingsView> {
    const record = await this.#o.store.get(workspaceId);
    return view(toSettings(record), record?.version ?? 0);
  }

  /**
   * Applies `patch` if `ifMatch` accepts the settings' current version; returns the new settings.
   * Throws 404 for a workspace that is gone, 412 for a stale ETag, 422 for an override above the
   * plan's cap, 503 when the cap cannot be read.
   */
  async update(
    workspaceId: string,
    patch: SettingsPatch,
    ifMatch: IfMatch,
    ctx: RequestCtx,
  ): Promise<SettingsView> {
    const result = await this.#o.store.transaction(async (tx) => {
      if (!(await tx.lockWorkspace(workspaceId))) {
        throw notFound(SETTINGS_DETAILS.notFound);
      }
      return this.#change(tx, workspaceId, patch, ctx, { ifMatch, pointer: '' });
    });
    await this.#announce(workspaceId, result.changed);
    return result.view;
  }

  /**
   * The `settings` field of `PATCH /v1/workspaces/{id}` (register it on B027's registry): the
   * same change, in the workspace PATCH's transaction, under the workspace's ETag.
   */
  patchExtension(): PatchExtension {
    return {
      key: 'settings',
      parse: (value) => checkSettingsPatch(value),
      apply: async (tx, workspaceId, value, ctx) => {
        const settings = this.#o.store.within(tx.trx);
        const { changed } = await this.#change(settings, workspaceId, value as SettingsPatch, ctx, {
          pointer: '/settings',
        });
        return changed.length === 0 ? undefined : () => this.#announce(workspaceId, changed);
      },
    };
  }

  /**
   * The change itself, in `tx` (the workspace row locked). `ifMatch` checks the settings' ETag;
   * `pointer` is where the settings sit in the request body (for a 422's pointers).
   */
  async #change(
    tx: WorkspaceSettingsTx,
    workspaceId: string,
    patch: SettingsPatch,
    ctx: RequestCtx,
    { ifMatch, pointer }: { ifMatch?: IfMatch; pointer: string },
  ): Promise<{ view: SettingsView; changed: SettingsKey[] }> {
    const stored = await tx.read(workspaceId);
    const version = stored?.version ?? 0;
    if (ifMatch !== undefined && !ifMatchAccepts(ifMatch, String(version))) {
      throw new AppError('precondition_failed', { detail: SETTINGS_DETAILS.stale });
    }
    const days = patch.history_retention_days;
    if (days !== undefined && days !== null) await this.#checkCap(workspaceId, days, pointer);
    const before = toSettings(stored);
    const after: WorkspaceSettings = { ...before, ...patch };
    const changed = SETTINGS_KEYS.filter((key) => after[key] !== before[key]);
    if (changed.length === 0) return { view: view(before, version), changed };
    await tx.write(
      workspaceId,
      {
        autoApprove: after.auto_approve,
        shareHistory: after.share_history,
        retentionDays: after.history_retention_days,
      },
      version + 1,
    );
    const meta: Record<string, AuditMetaValue> = { fields: changed.join(',') };
    for (const key of changed) {
      meta[`${AUDIT_NAMES[key]}_from`] = before[key];
      meta[`${AUDIT_NAMES[key]}_to`] = after[key];
    }
    await ctx.audit(tx.trx, {
      action: 'workspace.update',
      workspaceId,
      target: { type: 'workspace', id: workspaceId },
      meta,
    });
    this.#metrics.counter('workspace_settings_changed_total').inc();
    this.#o.logger?.info({ workspace_id: workspaceId, changed }, 'workspace.settings_changed');
    return { view: view(after, version + 1), changed };
  }

  /** 422 when `days` exceeds the plan's `history_days`; 503 when that cannot be read. */
  async #checkCap(workspaceId: string, days: number, pointer: string): Promise<void> {
    let cap: number;
    try {
      cap = await this.#o.entitlements.historyDays(workspaceId);
    } catch {
      throw unavailable(1, SETTINGS_DETAILS.entitlements);
    }
    if (!Number.isSafeInteger(cap) || cap < 0) throw unavailable(1, SETTINGS_DETAILS.entitlements);
    if (days > cap) {
      throw validationFailed(
        [
          {
            pointer: `${pointer}/history_retention_days`,
            code: 'out_of_range',
            detail: SETTINGS_DETAILS.overCap,
          },
        ],
        INVALID_SETTINGS_DETAIL,
      );
    }
  }

  /** Announces the change; never throws (the stored value is authoritative). */
  async #announce(workspaceId: string, changed: readonly SettingsKey[]): Promise<void> {
    if (changed.length === 0) return;
    const at = new Date(this.#clock());
    for (let attempt = 1; attempt <= SETTINGS_PUBLISH_ATTEMPTS; attempt++) {
      try {
        await publishWorkspaceSettingsChanged(this.#o.events, workspaceId, changed, at);
        return;
      } catch {
        if (attempt < SETTINGS_PUBLISH_ATTEMPTS) {
          await this.#sleep(SETTINGS_PUBLISH_BACKOFF_MS * 2 ** (attempt - 1));
        }
      }
    }
    this.#metrics.counter('workspace_settings_publish_failures_total').inc();
    this.#o.logger?.error({ workspace_id: workspaceId }, 'workspace.settings_publish_failed');
  }
}
