/**
 * Test helpers for seats (B030): an entitlements stand-in serving CT-ENTITLEMENTS fixtures from
 * `contracts/fixtures/entitlements/` (free: 1 seat, team: 5, and team with `max_seats: null` for
 * unlimited), a scripted transaction that records what the gate runs, a seat counter with fixed
 * answers, and a metrics recorder.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Api } from '@centcom/contracts';
import type { AuditDb } from '@centcom/core';
import type { CompiledQuery, QueryResult } from 'kysely';
import type { EntitlementService } from '../../../src/modules/entitlements/service.js';
import type { SeatUsage } from '../../../src/modules/seats/index.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../../contracts/fixtures/entitlements');

/** The `data` of a CT-ENTITLEMENTS fixture. */
export function entitlementsFixture(name: 'free' | 'pro' | 'team'): Api.Entitlements {
  const raw = JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as {
    data: Api.Entitlements;
  };
  return raw.data;
}

/** An entitlements service answering `get` with a fixture, `max_seats` optionally replaced. */
export function fixtureEntitlements(
  name: 'free' | 'pro' | 'team',
  maxSeats?: number | null,
): Pick<EntitlementService, 'get'> {
  const data = entitlementsFixture(name);
  const limits = maxSeats === undefined ? data.limits : { ...data.limits, max_seats: maxSeats };
  return { get: () => Promise.resolve({ ...data, limits }) };
}

/**
 * A transaction that records each statement's SQL and answers `current_setting` with
 * `lock_timeout` (default '0'); `fail` may throw for a statement instead.
 */
export function scriptedTrx(fail?: (sql: string) => Error | undefined): AuditDb & {
  statements: string[];
  parameters: unknown[][];
} {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  return {
    statements,
    parameters,
    isTransaction: true,
    executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>> {
      statements.push(query.sql.replace(/\s+/g, ' ').trim());
      parameters.push([...query.parameters]);
      const error = fail?.(query.sql);
      if (error !== undefined) return Promise.reject(error);
      if (query.sql.includes('current_setting')) {
        return Promise.resolve({ rows: [{ value: '0' } as R] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

/** A seat counter with fixed answers, recording the executor it was given. */
export function fixedSeats(members: number, pending = 0) {
  const calls: { workspaceId: string; trx: AuditDb | undefined }[] = [];
  return {
    calls,
    usage(workspaceId: string, trx?: AuditDb): Promise<SeatUsage> {
      calls.push({ workspaceId, trx });
      return Promise.resolve({ members, pending_invites: pending, total: members + pending });
    },
  };
}
