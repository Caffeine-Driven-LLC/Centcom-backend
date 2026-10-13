/**
 * Clock skew between API nodes (B096): a token signed by node A is presented to node B whose clock
 * is off. The rule (jwt.ts, 60 s tolerance on `exp`, `nbf` and `iat`): within 60 s either way is
 * accepted; a token from further in the future is `token_invalid`; one more than 60 s past its
 * 15-minute expiry is `token_expired`; nothing crashes. Needs Postgres and Redis (DATABASE_URL and
 * REDIS_URL, or Docker); it injects no fault, so it also runs in the normal test run when they are set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig, z } from '@centcom/core';
import { generateSigningJwk } from '../../src/modules/auth/tokens/keys.js';
import { ACCESS_TOKEN_TTL_S } from '../../src/modules/auth/tokens/index.js';
import { startNode, type Node } from './harness.js';

const urls = defineConfig(
  z.object({ DATABASE_URL: z.string().optional(), REDIS_URL: z.string().optional() }),
);
const HAS_STACK = urls.DATABASE_URL !== undefined && urls.REDIS_URL !== undefined;

describe.runIf(HAS_STACK)('clock skew between two API nodes', () => {
  const keys = JSON.stringify([generateSigningJwk('t1')]);
  const env = { AUTH_SIGNING_KEYS: keys, AUTH_SIGNING_KID: 't1' };
  let a: Node;
  const skewed: Node[] = [];
  const at = async (offsetS: number): Promise<Node> => {
    const node = await startNode({
      stack: a.stack,
      env,
      clock: () => Date.now() + offsetS * 1000,
    });
    skewed.push(node);
    return node;
  };

  beforeAll(async () => {
    a = await startNode({ env });
  }, 120_000);
  afterAll(async () => {
    for (const n of skewed) await n.stop();
    await a.stop();
  });

  const status = async (node: Node): Promise<{ code: number; problem: string | null }> => {
    const res = await node.app.inject({ method: 'GET', url: '/v1/me', headers: a.auth });
    return {
      code: res.statusCode,
      problem: res.statusCode === 200 ? null : res.json<{ code: string }>().code,
    };
  };

  it.each([
    [30, 200, null],
    [-30, 200, null],
    [120, 200, null], // the token is merely 2 minutes old: valid
    [ACCESS_TOKEN_TTL_S + 30, 200, null], // 30 s past exp: inside the tolerance
    [-120, 401, 'token_invalid'], // issued "in the future" beyond 60 s
    [300, 200, null],
    [ACCESS_TOKEN_TTL_S + 120, 401, 'token_expired'],
    [-300, 401, 'token_invalid'],
  ])('a node %i s ahead answers %i %s', async (offsetS, code, problem) => {
    const node = await at(offsetS);
    expect(await status(node)).toEqual({ code, problem });
  });
});
