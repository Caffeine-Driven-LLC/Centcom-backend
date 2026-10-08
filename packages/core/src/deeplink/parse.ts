/**
 * Reading Centcom's links (B033, CT-DEEPLINK): `parseDeepLink` takes a web or app URL from the
 * contract's table and says which link it is, or `{ ok: false }` and nothing more (no reason, no
 * echo of the input) for anything else. It never throws on its input.
 *
 * The match is literal, not a URL parser's normalised reading: exactly the configured web origin
 * or `centcom://`, the table's paths, a token of 27 base64url characters, a `ses_` id of CT-IDS.
 * Unknown query parameters are ignored; the ones a link names (`focus`, `code`, `state`) must
 * appear once with a valid value. A fragment, or a `k` parameter (key material where a server
 * would see it, CT-CRYPTO §4), refuses the link.
 *
 * Owns: the parser. Must not: return what was wrong with an input, or keep or log the input.
 */
import { isId } from '@centcom/contracts';
import {
  APP_SCHEME,
  AUTH_PARAM_PATTERN,
  DEFAULT_WEB_BASE_URL,
  isSessionFocus,
  LINK_TOKEN_PATTERN,
  type SessionFocus,
  webOrigin,
} from './urls.js';

/** Which form a link came in. */
export type DeepLinkForm = 'web' | 'app';

/** A link from the table. */
export type DeepLink =
  | { ok: true; kind: 'join' | 'invite' | 'share'; form: DeepLinkForm; token: string }
  | {
      ok: true;
      kind: 'session';
      form: DeepLinkForm;
      sessionId: string;
      focus: SessionFocus | null;
    }
  | { ok: true; kind: 'auth_callback'; form: 'app'; code: string; state: string }
  | { ok: true; kind: 'billing'; form: DeepLinkForm };

/** The kinds of link. */
export type DeepLinkKind = DeepLink['kind'];

/** Anything that is not a link from the table. */
export interface NotADeepLink {
  ok: false;
}

/** Options for parseDeepLink. */
export interface ParseDeepLinkOptions {
  /** The web origin links are on (WEB_BASE_URL); default `https://centcom.dev`. */
  webBase?: string;
}

/** Longer inputs are refused before any matching. */
export const MAX_DEEP_LINK_LENGTH = 2048;

const NOT_A_LINK: Readonly<NotADeepLink> = Object.freeze({ ok: false });

/** What may follow `?`: RFC 3986 query characters (no `#`, no spaces or controls). */
const QUERY_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/;
const TOKEN_KINDS = { j: 'join', i: 'invite', g: 'share' } as const;
const APP_TOKEN_KINDS = { join: 'join', invite: 'invite', share: 'share' } as const;
const TOKEN = LINK_TOKEN_PATTERN.source.slice(1, -1);
const WEB_TOKEN_PATH = new RegExp(`^/([jig])/(${TOKEN})$`);
const APP_TOKEN_PATH = new RegExp(`^(join|invite|share)/(${TOKEN})$`);
const SESSION_ID = '(ses_[0-9A-HJKMNP-TV-Z]{26})';
const WEB_SESSION_PATH = new RegExp(`^/s/${SESSION_ID}$`);
const APP_SESSION_PATH = new RegExp(`^session/${SESSION_ID}$`);

/** The query's parameters (raw, not decoded), or null when one appears twice or `k` is there. */
function readQuery(query: string, names: readonly string[]): Map<string, string | null> | null {
  const found = new Map<string, string | null>();
  if (query === '') return found;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (name === 'k') return null;
    if (!names.includes(name)) continue;
    if (found.has(name)) return null;
    found.set(name, eq < 0 ? null : part.slice(eq + 1));
  }
  return found;
}

function sessionLink(form: DeepLinkForm, id: string, query: string): DeepLink | NotADeepLink {
  if (!isId('ses', id)) return NOT_A_LINK;
  const params = readQuery(query, ['focus']);
  if (params === null) return NOT_A_LINK;
  const focus = params.get('focus');
  if (focus === undefined) return { ok: true, kind: 'session', form, sessionId: id, focus: null };
  return isSessionFocus(focus)
    ? { ok: true, kind: 'session', form, sessionId: id, focus }
    : NOT_A_LINK;
}

function plainLink(link: DeepLink, query: string): DeepLink | NotADeepLink {
  return readQuery(query, []) === null ? NOT_A_LINK : link;
}

function parseWeb(path: string, query: string): DeepLink | NotADeepLink {
  const token = WEB_TOKEN_PATH.exec(path);
  if (token !== null) {
    const kind = TOKEN_KINDS[token[1] as keyof typeof TOKEN_KINDS];
    return plainLink({ ok: true, kind, form: 'web', token: token[2] ?? '' }, query);
  }
  const session = WEB_SESSION_PATH.exec(path);
  if (session !== null) return sessionLink('web', session[1] ?? '', query);
  if (path === '/billing') return plainLink({ ok: true, kind: 'billing', form: 'web' }, query);
  return NOT_A_LINK;
}

function parseApp(path: string, query: string): DeepLink | NotADeepLink {
  const token = APP_TOKEN_PATH.exec(path);
  if (token !== null) {
    const kind = APP_TOKEN_KINDS[token[1] as keyof typeof APP_TOKEN_KINDS];
    return plainLink({ ok: true, kind, form: 'app', token: token[2] ?? '' }, query);
  }
  const session = APP_SESSION_PATH.exec(path);
  if (session !== null) return sessionLink('app', session[1] ?? '', query);
  if (path === 'billing') return plainLink({ ok: true, kind: 'billing', form: 'app' }, query);
  if (path === 'auth/callback') {
    const params = readQuery(query, ['code', 'state']);
    const code = params?.get('code');
    const state = params?.get('state');
    if (typeof code !== 'string' || !AUTH_PARAM_PATTERN.test(code)) return NOT_A_LINK;
    if (typeof state !== 'string' || !AUTH_PARAM_PATTERN.test(state)) return NOT_A_LINK;
    return { ok: true, kind: 'auth_callback', form: 'app', code, state };
  }
  return NOT_A_LINK;
}

/**
 * Which link `input` is, or `{ ok: false }`. Throws only for a `webBase` option that is not a
 * plain https origin (a caller's mistake, not the input's).
 */
export function parseDeepLink(
  input: string,
  options: ParseDeepLinkOptions = {},
): DeepLink | NotADeepLink {
  const origin = webOrigin(options.webBase ?? DEFAULT_WEB_BASE_URL);
  if (origin === null) throw new TypeError('the web base URL must be a plain https origin');
  if (typeof input !== 'string' || input.length > MAX_DEEP_LINK_LENGTH) return NOT_A_LINK;
  if (input.includes('#')) return NOT_A_LINK;
  const mark = input.indexOf('?');
  const path = mark < 0 ? input : input.slice(0, mark);
  const query = mark < 0 ? '' : input.slice(mark + 1);
  if (!QUERY_CHARS.test(query)) return NOT_A_LINK;
  if (path.startsWith(`${origin}/`)) return parseWeb(path.slice(origin.length), query);
  if (path.startsWith(APP_SCHEME)) return parseApp(path.slice(APP_SCHEME.length), query);
  return NOT_A_LINK;
}
