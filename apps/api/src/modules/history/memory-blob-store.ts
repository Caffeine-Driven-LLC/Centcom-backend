/**
 * An in-memory BlobStore (B055), for tests and local tools: the S3 store's behaviour (whole puts,
 * a missing key on get is BlobNotFoundError, idempotent deletes, sorted listing), with switches a
 * test flips to make an operation fail.
 *
 * Owns: the map. Must not: be used in production (nothing survives a restart).
 */
import { BlobNotFoundError, BlobStoreError, type BlobStore } from './blob-store.js';

/** The in-memory store and its test switches. */
export interface MemoryBlobStore extends BlobStore {
  objects: Map<string, Uint8Array>;
  /** Operations that fail, each for the given number of calls (Infinity: until reset). */
  failures: { put: number; get: number; delete: number; list: number };
  /** Every operation, in order: `put <key>`, `get <key>`, `delete <key>`, `list <prefix>`. */
  calls: string[];
}

/** A new, empty in-memory store. */
export function createMemoryBlobStore(): MemoryBlobStore {
  const objects = new Map<string, Uint8Array>();
  const failures = { put: 0, get: 0, delete: 0, list: 0 };
  const calls: string[] = [];
  const failing = (op: keyof typeof failures): boolean => {
    if (failures[op] <= 0) return false;
    failures[op] -= 1;
    return true;
  };
  return {
    objects,
    failures,
    calls,
    put(key, body) {
      calls.push(`put ${key}`);
      if (failing('put')) return Promise.reject(new BlobStoreError('PUT failed'));
      objects.set(key, new Uint8Array(body));
      return Promise.resolve();
    },
    get(key) {
      calls.push(`get ${key}`);
      if (failing('get')) return Promise.reject(new BlobStoreError('GET failed'));
      const body = objects.get(key);
      if (body === undefined) return Promise.reject(new BlobNotFoundError(key));
      return Promise.resolve(new Uint8Array(body));
    },
    delete(keys) {
      for (const key of keys) calls.push(`delete ${key}`);
      if (failing('delete')) return Promise.reject(new BlobStoreError('DELETE failed'));
      for (const key of keys) objects.delete(key);
      return Promise.resolve();
    },
    list(prefix) {
      calls.push(`list ${prefix}`);
      if (failing('list')) return Promise.reject(new BlobStoreError('LIST failed'));
      return Promise.resolve([...objects.keys()].filter((k) => k.startsWith(prefix)).sort());
    },
  };
}
