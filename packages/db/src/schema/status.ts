/**
 * Table types of the status feed (B086, migration 20260102002800_status.sql). Written by the API's
 * status service (for B087's admin tooling) and read by `GET /v1/status`.
 */
import type { ColumnType, Generated } from 'kysely';

/** An incident's status (CT-STATUS). */
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface StatusIncidentsTable {
  /** `inc_` id. */
  id: ColumnType<string, string, never>;
  title: string;
  status: IncidentStatus;
  component_ids: string[];
  started_at: ColumnType<Date, Date, never>;
  resolved_at: Date | null;
}

export interface StatusIncidentUpdatesTable {
  id: Generated<string>;
  incident_id: ColumnType<string, string, never>;
  at: ColumnType<Date, Date, never>;
  text: ColumnType<string, string, never>;
  status: ColumnType<IncidentStatus | null, IncidentStatus | null, never>;
}

export interface StatusDeprecationsTable {
  what: ColumnType<string, string, never>;
  /** `YYYY-MM-DD`, read as a Date by `pg`. */
  sunset: ColumnType<Date, string, string>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

/** The status tables. */
export interface StatusDatabase {
  status_incidents: StatusIncidentsTable;
  status_incident_updates: StatusIncidentUpdatesTable;
  status_deprecations: StatusDeprecationsTable;
}
