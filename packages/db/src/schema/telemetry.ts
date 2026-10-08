/**
 * Table types of telemetry (B085, migration 20260102002700_telemetry.sql). Written by the API's
 * telemetry module and its retention job; no column can hold an IP, user, device or request id.
 */
import type { ColumnType } from 'kysely';

export interface TelemetryEventsTable {
  /** The UTC day the event was received (the partition key). */
  day: ColumnType<Date, Date | string, never>;
  /** The client's random per-install ULID. */
  install_id: ColumnType<string, string, never>;
  type: ColumnType<string, string, never>;
  at: ColumnType<Date, Date, never>;
  /** Allow-listed props: written as JSON text, read as an object. */
  props: ColumnType<Record<string, string | number | boolean>, string, never>;
}

export interface TelemetryDailyAggTable {
  day: ColumnType<Date, Date | string, never>;
  type: ColumnType<string, string, never>;
  key: ColumnType<string, string, never>;
  /** A bigint, read as text by `pg`. */
  count: ColumnType<string, number, never>;
}

export interface TelemetryRollupsTable {
  day: ColumnType<Date, Date | string, never>;
  rolled_up_at: ColumnType<Date, Date | undefined, never>;
}

/** The telemetry tables. */
export interface TelemetryDatabase {
  telemetry_events: TelemetryEventsTable;
  telemetry_daily_agg: TelemetryDailyAggTable;
  telemetry_rollups: TelemetryRollupsTable;
}
