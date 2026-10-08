/**
 * The status feed's SQL (B086): incidents with their updates, and deprecations.
 *
 * - `feedIncidents` reads the open incidents and those resolved since a cut-off (7 days), with
 *   their updates in order, at most `limit` incidents: open ones first, newest first.
 * - Incident changes are single statements or one transaction (an update and the status it sets).
 *
 * Owns: these statements. Must not: store anything but ids, enums, times and the given text.
 */
import type { IncidentStatus, StatusDatabase } from '@centcom/db';
import { withTransaction } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

/** An incident with its updates. */
export interface IncidentRecord {
  id: string;
  title: string;
  status: IncidentStatus;
  componentIds: string[];
  startedAt: Date;
  resolvedAt: Date | null;
  updates: { at: Date; text: string; status: IncidentStatus | null }[];
}

/** A deprecation. */
export interface DeprecationRecord {
  what: string;
  /** `YYYY-MM-DD`. */
  sunset: string;
}

/** The status feed's persistence. */
export interface StatusRepository {
  /** Open incidents and those resolved since `resolvedSince`, open first, newest first. */
  feedIncidents(resolvedSince: Date, limit: number): Promise<IncidentRecord[]>;
  deprecations(): Promise<DeprecationRecord[]>;
  createIncident(incident: Omit<IncidentRecord, 'updates' | 'resolvedAt'>): Promise<void>;
  /** Adds an update; with a status, the incident takes it (`resolved` sets `resolved_at`). False when there is no such incident. */
  addUpdate(
    id: string,
    update: { at: Date; text: string; status: IncidentStatus | null },
  ): Promise<boolean>;
  /** Resolves an incident at `at`; false when there is none. */
  resolve(id: string, at: Date): Promise<boolean>;
  getIncident(id: string): Promise<IncidentRecord | null>;
  setDeprecation(deprecation: DeprecationRecord): Promise<void>;
}

type Db = Kysely<StatusDatabase>;

/** The repository over Postgres. */
export function createStatusRepository(db: Db): StatusRepository {
  async function withUpdates(
    rows: {
      id: string;
      title: string;
      status: IncidentStatus;
      component_ids: string[];
      started_at: Date;
      resolved_at: Date | null;
    }[],
  ): Promise<IncidentRecord[]> {
    if (rows.length === 0) return [];
    const updates = await db
      .selectFrom('status_incident_updates')
      .select(['incident_id', 'at', 'text', 'status'])
      .where(
        'incident_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      componentIds: r.component_ids,
      startedAt: r.started_at,
      resolvedAt: r.resolved_at,
      updates: updates
        .filter((u) => u.incident_id === r.id)
        .map((u) => ({ at: u.at, text: u.text, status: u.status })),
    }));
  }

  const COLUMNS = ['id', 'title', 'status', 'component_ids', 'started_at', 'resolved_at'] as const;

  return {
    async feedIncidents(resolvedSince, limit) {
      const rows = await db
        .selectFrom('status_incidents')
        .select(COLUMNS)
        .where((eb) =>
          eb.or([eb('resolved_at', 'is', null), eb('resolved_at', '>=', resolvedSince)]),
        )
        .orderBy(sql`resolved_at is null`, 'desc')
        .orderBy('started_at', 'desc')
        .limit(limit)
        .execute();
      return withUpdates(rows);
    },

    async deprecations() {
      const rows = await db
        .selectFrom('status_deprecations')
        .select(['what', sql<string>`to_char(sunset, 'YYYY-MM-DD')`.as('sunset')])
        .orderBy('sunset')
        .orderBy('what')
        .execute();
      return rows.map((r) => ({ what: r.what, sunset: r.sunset }));
    },

    async createIncident(incident) {
      await db
        .insertInto('status_incidents')
        .values({
          id: incident.id,
          title: incident.title,
          status: incident.status,
          component_ids: incident.componentIds,
          started_at: incident.startedAt,
          resolved_at: incident.status === 'resolved' ? incident.startedAt : null,
        })
        .execute();
    },

    addUpdate(id, update) {
      return withTransaction(db, async (trx) => {
        const exists = await trx
          .selectFrom('status_incidents')
          .select('id')
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (exists === undefined) return false;
        await trx
          .insertInto('status_incident_updates')
          .values({ incident_id: id, at: update.at, text: update.text, status: update.status })
          .execute();
        if (update.status !== null) {
          await trx
            .updateTable('status_incidents')
            .set({
              status: update.status,
              resolved_at: update.status === 'resolved' ? update.at : null,
            })
            .where('id', '=', id)
            .execute();
        }
        return true;
      });
    },

    async resolve(id, at) {
      const done = await db
        .updateTable('status_incidents')
        .set({ status: 'resolved', resolved_at: sql<Date>`coalesce(resolved_at, ${at})` })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(done.numUpdatedRows) > 0;
    },

    async getIncident(id) {
      const rows = await db
        .selectFrom('status_incidents')
        .select(COLUMNS)
        .where('id', '=', id)
        .execute();
      return (await withUpdates(rows))[0] ?? null;
    },

    async setDeprecation(deprecation) {
      await db
        .insertInto('status_deprecations')
        .values({ what: deprecation.what, sunset: deprecation.sunset })
        .onConflict((oc) => oc.column('what').doUpdateSet({ sunset: deprecation.sunset }))
        .execute();
    },
  };
}
