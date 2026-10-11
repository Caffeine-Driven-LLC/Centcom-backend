/**
 * Table types of the relay's agent registry (B057, migration 20260102004700_agents.sql). Written
 * by the relay's agents module (a write-through of its Redis registry); ids, mode, state name,
 * outcome and seqs only, never a label, branch, worktree or model.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase } from './core.js';

/** `bigint`: pg returns it as a string. */
type Seq = ColumnType<string, number, never>;

/** One agent of one session. */
export interface AgentTable {
  session_id: ColumnType<string, string, never>;
  agent_id: ColumnType<string, string, never>;
  owner_member: ColumnType<string, string, never>;
  mode: ColumnType<'command_post' | 'branch', 'command_post' | 'branch', never>;
  /** The latest state name ('' before the first `agent.state`). */
  state: string;
  /** When that state began, as the frame gave it. */
  since: string;
  spawned_seq: Seq;
  spawn_frame_id: ColumnType<string, string, never>;
  /** The member who sent the spawn. */
  spawned_by: ColumnType<string, string, never>;
  exited_seq: ColumnType<string | null, number | null | undefined, number | null>;
  outcome: 'ok' | 'error' | 'canceled' | null;
  error_code: string | null;
  /** `agent_rev_seq` at the last write (the Redis copy's watermark); pg returns it as a string. */
  rev: ColumnType<string, never, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** The agent registry's tables. */
export interface AgentTables {
  agent: AgentTable;
}

/** The core tables with the agent registry's. */
export type AgentsDatabase = CoreDatabase & AgentTables;
