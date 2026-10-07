/**
 * Shared set-up for the RBAC tests: the CT-RBAC tables read from contracts/01-auth-rbac.md, the
 * mapping from their rows to catalogue actions, ids, and an in-memory MembershipReader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Actor,
  MembershipReader,
  SessionAction,
  SessionRole,
  WorkspaceAction,
  WorkspaceRole,
} from '../../src/index.js';

export const ACTOR_ID = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
export const OTHER_ID = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X';
export const WORKSPACE = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
export const OTHER_WORKSPACE = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4X';
export const SESSION = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

/** A user actor with every scope (roles decide, not scopes). */
export const user = (userId = ACTOR_ID): Actor => ({ kind: 'user', userId, scopes: ['profile'] });

/** One parsed contract table. */
export interface ContractTable {
  roles: string[];
  rows: { label: string; cells: string[] }[];
}

const CONTRACT = readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', 'contracts', '01-auth-rbac.md'),
  'utf8',
);

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/** The CT-RBAC table whose header's first cell is `first` ("Action" or "Session action"). */
export function contractTable(first: string): ContractTable {
  const section = CONTRACT.slice(CONTRACT.indexOf('## CT-RBAC'));
  const lines = section.split('\n');
  const start = lines.findIndex((line) => line.startsWith('|') && cellsOf(line)[0] === first);
  if (start === -1) throw new Error(`no CT-RBAC table starting with ${first}`);
  const header = cellsOf(lines[start] ?? '');
  const rows: ContractTable['rows'] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const [label = '', ...cells] = cellsOf(line);
    rows.push({ label, cells });
  }
  return { roles: header.slice(1), rows };
}

/** Which actions each row of the workspace table governs. */
export const WORKSPACE_ROWS: Readonly<Record<string, readonly WorkspaceAction[]>> = {
  'Read workspace, members': ['workspace.read'],
  'Update workspace settings': ['workspace.update'],
  'Invite / remove members': ['member.invite', 'member.remove'],
  'Change member role': ['member.role.change'],
  'Transfer ownership': ['workspace.transfer'],
  'View billing, invoices': ['billing.read'],
  'Change plan, payment method, seats': ['billing.manage'],
  'Create/host session': ['session.create'],
  'Join session (as editor)': ['session.join.editor'],
  'Join session (as viewer)': ['session.join.viewer'],
  'Read audit log': ['audit.read'],
  'Manage webhooks, API keys': ['webhook.manage', 'apikey.manage.any', 'apikey.manage.own'],
  'Delete workspace': ['workspace.delete'],
};

/** Which actions each row of the session table governs. */
export const SESSION_ROWS: Readonly<Record<string, readonly SessionAction[]>> = {
  'Send frames of type `message.user`, submit queue item': [
    'session.message.send',
    'session.queue.submit',
  ],
  'Approve / reject / reorder / drop queue items': ['session.queue.decide'],
  'Approve tool calls': ['session.tool.approve'],
  "Run agents (host's runner)": ['session.agent.run'],
  'Spawn own branch agent (branch mode)': ['session.agent.spawn_branch'],
  'Presence, cursors, reactions, comments': [
    'session.presence',
    'session.react',
    'session.comment',
  ],
  'Kick, mute, change roles, end session, transfer host': ['session.control'],
  'Read history': ['session.history.read'],
};

/** Roles of one user, held in memory; `fail` makes every read throw. */
export function memoryMemberships(): MembershipReader & {
  workspace: Map<string, WorkspaceRole>;
  session: Map<string, SessionRole>;
  reads: number;
  fail: boolean;
} {
  const reader = {
    workspace: new Map<string, WorkspaceRole>(),
    session: new Map<string, SessionRole>(),
    reads: 0,
    fail: false,
    workspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
      reader.reads += 1;
      if (reader.fail) return Promise.reject(new Error('connection refused'));
      return Promise.resolve(reader.workspace.get(`${userId}|${workspaceId}`) ?? null);
    },
    sessionRole(userId: string, sessionId: string): Promise<SessionRole | null> {
      reader.reads += 1;
      if (reader.fail) return Promise.reject(new Error('connection refused'));
      return Promise.resolve(reader.session.get(`${userId}|${sessionId}`) ?? null);
    },
  };
  return reader;
}
