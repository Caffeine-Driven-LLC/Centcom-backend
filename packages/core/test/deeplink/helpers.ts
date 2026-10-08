/**
 * Test helpers for deep links (B033): CT-DEEPLINK's table read from the contract itself (so a row
 * added there fails the golden test until it is built), sample values for its placeholders, and
 * an oracle of the table's patterns written apart from the parser.
 */
import { readFileSync } from 'node:fs';

/** One row of the table: the purpose and its two cells ('—' when a form does not exist). */
export interface TableRow {
  purpose: string;
  web: string;
  app: string;
}

const CONTRACT = new URL('../../../../contracts/08-integrations.md', import.meta.url);

/** The CT-DEEPLINK table, as written in contracts/08-integrations.md. */
export function deeplinkTable(): TableRow[] {
  const text = readFileSync(CONTRACT, 'utf8');
  const section = text.slice(text.indexOf('## CT-DEEPLINK'));
  const rows: TableRow[] = [];
  for (const line of section.split('\n').slice(1)) {
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| Purpose')) continue;
    // The pipes inside `[?focus=approval|queue]` are not cell borders: split on ' | ' and '| '.
    const cells = line
      .replace(/^\|\s*/, '')
      .replace(/\s*\|$/, '')
      .split(/\s+\|\s+/)
      .map((cell) => cell.replace(/`/g, '').trim());
    rows.push({ purpose: cells[0] ?? '', web: cells[1] ?? '', app: cells[2] ?? '' });
    if (rows.length > 20) break;
  }
  return rows;
}

/** A 27-character token (what generateLinkToken makes). */
export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0';
/** Another one, with `-` and `_`. */
export const TOKEN_2 = 'zZ9_-aaaaaaaaaaaaaaaaaaaaaA';
/** A session id (CT-IDS). */
export const SES = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
/** An authorization code and a state. */
export const CODE = 'c0de_FROM-the.server~1';
export const STATE = 'st4te-from_client';

/** A cell with its placeholders filled in (and `…` in the auth callback). */
export function fill(cell: string, values: { focus?: string } = {}): string {
  return cell
    .replace('<invite_token>', TOKEN)
    .replace('<share_token>', TOKEN)
    .replace('<ses_id>', SES)
    .replace('[?focus=approval|queue]', values.focus === undefined ? '' : `?focus=${values.focus}`)
    .replace('code=…', `code=${CODE}`)
    .replace('state=…', `state=${STATE}`);
}

const T = '[A-Za-z0-9_-]{27}';
const S = 'ses_[0-9A-HJKMNP-TV-Z]{26}';
const Q = "(?:\\?[A-Za-z0-9\\-._~!$&'()*+,;=:@/?%]*)?";
const WEB = 'https://centcom\\.dev';

/** The table's patterns (default origin), each with the kind it means. */
export const ORACLE: readonly { kind: string; form: 'web' | 'app'; re: RegExp }[] = [
  { kind: 'join', form: 'web', re: new RegExp(`^${WEB}/j/(${T})${Q}$`) },
  { kind: 'invite', form: 'web', re: new RegExp(`^${WEB}/i/(${T})${Q}$`) },
  { kind: 'share', form: 'web', re: new RegExp(`^${WEB}/g/(${T})${Q}$`) },
  { kind: 'session', form: 'web', re: new RegExp(`^${WEB}/s/(${S})${Q}$`) },
  { kind: 'billing', form: 'web', re: new RegExp(`^${WEB}/billing${Q}$`) },
  { kind: 'join', form: 'app', re: new RegExp(`^centcom://join/(${T})${Q}$`) },
  { kind: 'invite', form: 'app', re: new RegExp(`^centcom://invite/(${T})${Q}$`) },
  { kind: 'share', form: 'app', re: new RegExp(`^centcom://share/(${T})${Q}$`) },
  { kind: 'session', form: 'app', re: new RegExp(`^centcom://session/(${S})${Q}$`) },
  { kind: 'billing', form: 'app', re: new RegExp(`^centcom://billing${Q}$`) },
  { kind: 'auth_callback', form: 'app', re: new RegExp(`^centcom://auth/callback${Q}$`) },
];
