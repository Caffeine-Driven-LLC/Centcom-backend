/**
 * Request context (B005 acceptance 6, at the library level): the context follows a request
 * through await, timers, promise callbacks and nested async calls, and concurrent requests stay
 * apart.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { getRequestContext, runWithContext } from '../../src/index.js';
import { REQUEST_ID, SESSION_ID, USER_ID } from './helpers.js';

const id = (n: number): string => `req_01JA3Z8K2M5N7P9Q0R1S2T3V${String(n).padStart(2, '0')}`;

describe('request context', () => {
  it('is undefined outside a request', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("returns fn's result and exposes the context inside it", () => {
    const result = runWithContext({ requestId: REQUEST_ID }, () => getRequestContext()?.requestId);
    expect(result).toBe(REQUEST_ID);
    expect(getRequestContext()).toBeUndefined();
  });

  it('survives await, timers, promise callbacks and nested async calls', async () => {
    const seen: (string | undefined)[] = [];
    const nested = async (): Promise<void> => {
      await sleep(1);
      seen.push(getRequestContext()?.requestId);
    };
    await runWithContext({ requestId: REQUEST_ID }, async () => {
      await sleep(1);
      seen.push(getRequestContext()?.requestId);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          seen.push(getRequestContext()?.requestId);
          resolve();
        }, 2),
      );
      await Promise.resolve().then(() => seen.push(getRequestContext()?.requestId));
      await Promise.all([nested(), nested()]);
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          seen.push(getRequestContext()?.requestId);
          resolve();
        }),
      );
    });
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set([REQUEST_ID]));
  });

  it('keeps concurrent requests apart', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        runWithContext({ requestId: id(n) }, async () => {
          await sleep((n * 7) % 5);
          return getRequestContext()?.requestId;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: 20 }, (_, n) => id(n)));
  });

  it('copies the context it is given: later changes to that object do not leak in', () => {
    const ctx: { requestId: string; userId?: string } = { requestId: REQUEST_ID };
    runWithContext(ctx, () => {
      ctx.userId = USER_ID;
      expect(getRequestContext()?.userId).toBeUndefined();
    });
  });

  it('lets auth code record the user and session for the rest of the request', async () => {
    await runWithContext({ requestId: REQUEST_ID }, async () => {
      const ctx = getRequestContext();
      if (ctx) {
        ctx.userId = USER_ID;
        ctx.sessionId = SESSION_ID;
      }
      await sleep(1);
      expect(getRequestContext()).toEqual({
        requestId: REQUEST_ID,
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
    });
  });

  it('a nested context shadows the outer one, which comes back afterwards', () => {
    runWithContext({ requestId: id(1) }, () => {
      runWithContext({ requestId: id(2) }, () => {
        expect(getRequestContext()?.requestId).toBe(id(2));
      });
      expect(getRequestContext()?.requestId).toBe(id(1));
    });
  });
});
