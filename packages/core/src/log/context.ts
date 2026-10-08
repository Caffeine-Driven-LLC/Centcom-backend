/**
 * Request context (B005): the ids of the request being handled, kept in AsyncLocalStorage so code
 * deep in a call chain can log them without passing them along. The logger adds them to every line.
 *
 * Owns: the context store. Must not: hold anything but ids (no names, e-mail addresses, tokens or
 * payloads), or be read for authorisation decisions (it is a logging aid).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The ids of the current request. Auth code may set `userId` and `sessionId` once known. */
export interface RequestContext {
  /** A CT-IDS `req_` id. */
  readonly requestId: string;
  /** A CT-IDS `usr_` id. */
  userId?: string;
  /** A CT-IDS `ses_` id. */
  sessionId?: string;
  /** The W3C trace id (32 hex) of the request's sampled span (B093), for log correlation. */
  traceId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The context of the request whose code is running, or undefined outside any request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with a copy of `ctx` as the current request context. The context follows `fn`
 * through `await`, timers, promise callbacks and nested async calls.
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run({ ...ctx }, fn);
}
