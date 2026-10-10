/**
 * Purging a deleted workspace at once (B090, CT-WS-ENVELOPE "Deletion and retention": deleting a
 * workspace purges immediately): `purgeWorkspace(workspaceId)` purges the durable history (and
 * snapshots, once B056 stores them) of every session of the workspace, whatever its state, blobs
 * first and then rows, and writes a `history.purge` audit event with the counts (`frames`,
 * `blobs`; actor `system`/`retention`, target the workspace) when it purged anything (a retry
 * that finds nothing left writes none). The event is written outside the workspace (`workspaceId`
 * null), because B027's purge deletes the workspace's own events next. Register this hook in place
 * of B055's `history` hook (or before it), or the history is gone before it counts.
 *
 * Idempotent: a session already purged purges nothing, so a retried purge (B027 retries its hooks'
 * job) finishes what a failed one left. It runs as B027's `retention` purge hook, or as the
 * `retention` queue's `purge-workspace` job.
 *
 * Owns: the purge and its audit event. Must not: delete the workspace or its sessions (B027 does),
 * or log session ids.
 */
import type { AuditEmitter, Logger } from '@centcom/core';
import type { SessionBlobPurger } from './history.js';
import type { PurgeHookRegistry } from '../workspace-purge.js';

/** The name of the workspace-purge hook. */
export const RETENTION_PURGE_HOOK = 'retention';

/** The sessions of a workspace (any state). */
export interface WorkspaceSessionsReader {
  sessionIds(workspaceId: string): Promise<string[]>;
}

/** What the purger needs. */
export interface WorkspacePurgerDeps {
  sessions: WorkspaceSessionsReader;
  history: SessionBlobPurger;
  /** B056's snapshot store, once it exists. */
  snapshots?: SessionBlobPurger;
  audit: Pick<AuditEmitter, 'emitDetached'>;
  logger?: Logger;
}

/** Purges deleted workspaces' blobs and rows. */
export interface WorkspacePurger {
  /** Purges the workspace's history and snapshots; the blobs and rows it deleted. */
  purgeWorkspace(workspaceId: string): Promise<{ blobs: number; rows: number }>;
}

/** The purger (see the module comment). */
export function createWorkspacePurger(deps: WorkspacePurgerDeps): WorkspacePurger {
  return {
    async purgeWorkspace(workspaceId) {
      let blobs = 0;
      let rows = 0;
      const sessions = await deps.sessions.sessionIds(workspaceId);
      for (const sessionId of sessions) {
        if (deps.snapshots !== undefined) {
          const snap = await deps.snapshots.purge(sessionId);
          blobs += snap.blobs;
          rows += snap.deleted;
        }
        const history = await deps.history.purge(sessionId);
        blobs += history.blobs;
        rows += history.deleted;
      }
      if (rows > 0 || blobs > 0) {
        deps.audit.emitDetached({
          workspaceId: null,
          actor: { type: 'system', id: 'retention' },
          action: 'history.purge',
          target: { type: 'workspace', id: workspaceId },
          outcome: 'success',
          meta: { frames: rows, blobs },
        });
      }
      deps.logger?.info(
        { workspace_id: workspaceId, sessions: sessions.length, frames: rows, blobs },
        'retention.workspace_purged',
      );
      return { blobs, rows };
    },
  };
}

/** Registers the purger as B027's `retention` workspace-purge hook. */
export function registerRetentionPurgeHook(
  hooks: PurgeHookRegistry,
  purger: WorkspacePurger,
): void {
  hooks.register(RETENTION_PURGE_HOOK, async (workspaceId) => {
    await purger.purgeWorkspace(workspaceId);
  });
}
