/**
 * B059 privacy (acceptance 7; guardrail: arbitrate on the hash only): only a `path_hmac` matching
 * `^[A-Za-z0-9_-]+$` of at most 64 characters is accepted; the service never receives or stores
 * `p.path` (inside `ct`): every Redis key and value written during a run is scanned against an
 * allow-list of fields and for the path; logs carry no path either.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { lock, lockEnv } from './helpers.js';

const PATH = 'src/secret/billing-plan.ts';

describe('lock privacy (acceptance 7)', () => {
  it('accepts only path_hmac of the contract shape, at most 64 characters', async () => {
    const env = lockEnv();
    for (const bad of ['', 'a/b', 'a b', 'x'.repeat(65), PATH, 'é']) {
      expect(await env.send(lock('acquire', bad, newId('agt')), env.editor), bad).toMatchObject({
        outcome: 'refused',
        code: 'invalid_frame',
      });
    }
    expect(
      await env.send(lock('acquire', 'A_b-9'.padEnd(64, 'z'), newId('agt')), env.editor),
    ).toEqual({ outcome: 'granted' });
  });

  it('stores only allow-listed fields, never a path, even when a client puts one in p', async () => {
    const env = lockEnv();
    const [a, b] = [newId('agt'), newId('agt')];
    const frame = lock('acquire', 'hmacA', a, 10_000);
    frame.p['path'] = PATH; // a misbehaving client puts the path in the clear part
    await env.send(frame, env.editor);
    await env.send(lock('acquire', 'hmacA', b), env.other);
    await env.send(lock('release', 'hmacA', a), env.editor);
    env.clock.now += 400_000;
    await env.service.sweep(new Date(env.clock.now));
    const allowed = new Set([
      'v',
      'locks',
      'queues',
      'hmac',
      'agent',
      'member',
      'expiresAt',
      'expires_at',
      'ttlMs',
      'waiters',
      'frameId',
      'queuedAt',
      'members',
      'nodes',
      'departed',
      'mark',
    ]);
    for (const { key, value } of env.written) {
      expect(key).toMatch(/^(locks|lock):ses_[0-9A-Z]{26}(:mutex|:[A-Za-z0-9_-]+)?$/);
      expect(key).not.toContain(PATH);
      expect(value).not.toContain(PATH);
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue; // the mutex token
      }
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === 'object') {
          for (const [k, child] of Object.entries(v)) {
            expect(allowed.has(k), k).toBe(true);
            walk(child);
          }
        }
      };
      walk(parsed);
    }
    expect(env.captured.raw()).not.toContain(PATH);
    expect(env.written.length).toBeGreaterThan(0);
  });
});
