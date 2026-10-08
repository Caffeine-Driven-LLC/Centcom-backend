/**
 * The account lifecycle's adapters (B026): the export blob store over B082's object store uploads
 * a whole file signed over its SHA-256 and leaves no temporary file behind (even when the upload
 * fails); the workspace deleter deletes as the system actor `account-purge` and treats a workspace
 * that is already gone as done.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@centcom/contracts';
import { notFound, type AuditEvent } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  exportBlobStoreFrom,
  PURGE_ACTOR,
  workspaceDeleterFrom,
} from '../../src/modules/account-lifecycle/index.js';
import type { LocalFile, ObjectStore } from '../../src/modules/audit-api/object-store.js';

describe('exportBlobStoreFrom', () => {
  it('uploads the whole body through a private temporary file, then removes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b026-'));
    const puts: { key: string; file: LocalFile; body: string }[] = [];
    const store: ObjectStore = {
      putFile: async (key, file) => {
        puts.push({ key, file, body: await readFile(file.path, 'utf8') });
      },
      delete: () => Promise.resolve(),
      presignGet: (key, ttlS) => `https://objects.test/${key}?ttl=${ttlS}`,
    };
    const blobs = exportBlobStoreFrom(store, { tmpDir: dir });
    const body = new TextEncoder().encode('{"a":1}');
    await blobs.put('exports/usr/exp.json', body, 'application/json');
    expect(puts).toEqual([
      {
        key: 'exports/usr/exp.json',
        file: {
          path: expect.any(String),
          size: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
          contentType: 'application/json',
        },
        body: '{"a":1}',
      },
    ]);
    expect(await readdir(dir)).toEqual([]);
    expect(blobs.presignGet('k', 900, new Date())).toBe('https://objects.test/k?ttl=900');

    const failing = exportBlobStoreFrom(
      { ...store, putFile: () => Promise.reject(new Error('down')) },
      { tmpDir: dir },
    );
    await expect(failing.put('k', body, 'application/json')).rejects.toThrow('down');
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('workspaceDeleterFrom', () => {
  it('deletes as the purge, and a workspace already gone is done', async () => {
    const events: AuditEvent[] = [];
    const deleted: string[] = [];
    const emitter = {
      emit: (_trx: unknown, event: AuditEvent) => {
        events.push(event);
        return Promise.resolve(newId('aud'));
      },
    };
    const live = newId('wsp');
    const gone = newId('wsp');
    const broken = newId('wsp');
    const deleteWorkspace = workspaceDeleterFrom(
      {
        softDelete: async (workspaceId, ifMatch, ctx) => {
          expect(ifMatch).toBeUndefined();
          if (workspaceId === gone) throw notFound('There is no such workspace.');
          if (workspaceId === broken) throw new Error('db down');
          deleted.push(workspaceId);
          await ctx.audit({} as never, {
            action: 'workspace.delete',
            workspaceId: null,
            target: { type: 'workspace', id: workspaceId },
          });
        },
      },
      emitter as never,
    );
    await deleteWorkspace(live);
    await deleteWorkspace(gone);
    await expect(deleteWorkspace(broken)).rejects.toThrow('db down');
    expect(deleted).toEqual([live]);
    expect(events).toEqual([
      {
        workspaceId: null,
        actor: { type: 'system', id: PURGE_ACTOR },
        outcome: 'success',
        action: 'workspace.delete',
        target: { type: 'workspace', id: live },
      },
    ]);
  });
});
