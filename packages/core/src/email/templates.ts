/**
 * Email templates (B032): typed parameters, a renderer that escapes every value it puts into HTML,
 * and this lane's three templates (`workspace_invite`, `account_deletion_scheduled`,
 * `export_ready`). Later lanes add theirs to a registry with `registerTemplate`, and their
 * parameter types to `TemplateParams` (declaration merging).
 *
 * Owns: rendering subject, HTML and plain text. Must not: put a parameter into HTML unescaped,
 * accept pre-built HTML from callers, or add tracking parameters or redirects to links. Copy is
 * English (localisation is out of scope).
 *
 * The tag is called `markup`, not `html`: Prettier reformats `html` template literals as HTML,
 * which would rewrite the emails' whitespace.
 */
import { validationFailed, type FieldError } from '../errors/app-error.js';
import {
  checkDateParam,
  checkTextParam,
  checkUrlParam,
  EMAIL_DETAILS,
  MAX_SUBJECT_LENGTH,
} from './validation.js';

/** Every template's parameters, by template id. Lanes add theirs by declaration merging. */
export interface TemplateParams {
  workspace_invite: { inviterName: string; workspaceName: string; url: string; expiresAt: Date };
  account_deletion_scheduled: { displayName: string; deletionDate: Date; restoreUrl: string };
  export_ready: { displayName: string; url: string; expiresAt: Date };
}

/** A template id. */
export type TemplateId = keyof TemplateParams;

/**
 * The ids of this lane's templates. Typed apart from TemplateId, which grows as lanes add
 * templates (B014 adds `magic_link`), so the built-in set never has to list theirs.
 */
export type BuiltInTemplateId = 'workspace_invite' | 'account_deletion_scheduled' | 'export_ready';

/** How a parameter is checked: text (escaped), a link (https, used as given), or a date. */
export type ParamKind = 'text' | 'url' | 'date';

const SAFE = Symbol('safe markup');

/** HTML the renderer built; caller input never becomes one. */
export interface SafeHtml {
  readonly [SAFE]: string;
}

/** `value` with `& < > " '` replaced by entities. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const isSafe = (value: unknown): value is SafeHtml =>
  typeof value === 'object' && value !== null && SAFE in value;

/**
 * Builds HTML from a template literal: every interpolated value is escaped, except HTML this tag
 * built itself (so templates compose). Arrays join their items.
 */
export function markup(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  const piece = (value: unknown): string =>
    isSafe(value)
      ? value[SAFE]
      : Array.isArray(value)
        ? value.map(piece).join('')
        : escapeHtml(String(value));
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += piece(value) + (strings[i + 1] ?? '');
  });
  return { [SAFE]: out };
}

/** One template. */
export interface EmailTemplate<P> {
  /** The kind of each parameter; every parameter is checked by its kind before rendering. */
  readonly params: Readonly<Record<keyof P & string, ParamKind>>;
  subject(params: P): string;
  /** The body (built with `markup`); the layout wraps it. */
  html(params: P): SafeHtml;
  /** The plain-text body (mandatory); the layout adds the footer. */
  text(params: P): string;
}

/** What rendering produces: everything a provider needs but the recipient and sender. */
export interface RenderedContent {
  subject: string;
  html: string;
  text: string;
  /** The template id, sent as the provider's tag. */
  tag: string;
}

/** A date as the copy shows it: `7 October 2026` (UTC). */
export const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(date);

const FOOTER = 'You received this email because of activity on your Centcom account.';

/** The subject, cut to MAX_SUBJECT_LENGTH with an ellipsis. */
const limitSubject = (subject: string): string =>
  subject.length <= MAX_SUBJECT_LENGTH ? subject : `${subject.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;

/** The page around a body. */
const layout = (subject: string, body: SafeHtml): string =>
  markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${subject}</title>
</head>
<body style="font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.5;">
${body}
<p style="color: #666666; font-size: 12px;">${FOOTER}</p>
</body>
</html>
`[SAFE];

/** A paragraph with one link. */
const link = (url: string, label: string): SafeHtml => markup`<p><a href="${url}">${label}</a></p>`;

/** Lines of text, joined by blank lines. */
const paragraphs = (...lines: string[]): string => lines.join('\n\n');

/** This lane's templates. */
export const BUILT_IN_TEMPLATES: {
  readonly [T in BuiltInTemplateId]: EmailTemplate<TemplateParams[T]>;
} = Object.freeze({
  workspace_invite: {
    params: { inviterName: 'text', workspaceName: 'text', url: 'url', expiresAt: 'date' },
    subject: (p) => `${p.inviterName} invited you to ${p.workspaceName} on Centcom`,
    html: (p) =>
      markup`<p>${p.inviterName} invited you to join <strong>${p.workspaceName}</strong> on Centcom.</p>
${link(p.url, 'Accept the invitation')}
<p>The invitation expires on ${formatDate(p.expiresAt)}. If you did not expect it, you can ignore this email.</p>`,
    text: (p) =>
      paragraphs(
        `${p.inviterName} invited you to join ${p.workspaceName} on Centcom.`,
        `Accept the invitation: ${p.url}`,
        `The invitation expires on ${formatDate(p.expiresAt)}. If you did not expect it, you can ignore this email.`,
      ),
  },
  account_deletion_scheduled: {
    params: { displayName: 'text', deletionDate: 'date', restoreUrl: 'url' },
    subject: () => 'Your Centcom account is scheduled for deletion',
    html: (p) =>
      markup`<p>Hello ${p.displayName},</p>
<p>Your Centcom account and its data will be deleted on ${formatDate(p.deletionDate)}.</p>
${link(p.restoreUrl, 'Keep my account')}
<p>If you change your mind before then, follow the link to restore it.</p>`,
    text: (p) =>
      paragraphs(
        `Hello ${p.displayName},`,
        `Your Centcom account and its data will be deleted on ${formatDate(p.deletionDate)}.`,
        `Keep my account: ${p.restoreUrl}`,
        'If you change your mind before then, follow the link to restore it.',
      ),
  },
  export_ready: {
    params: { displayName: 'text', url: 'url', expiresAt: 'date' },
    subject: () => 'Your Centcom data export is ready',
    html: (p) =>
      markup`<p>Hello ${p.displayName},</p>
<p>The export of your Centcom data is ready.</p>
${link(p.url, 'Download the export')}
<p>The link expires on ${formatDate(p.expiresAt)}.</p>`,
    text: (p) =>
      paragraphs(
        `Hello ${p.displayName},`,
        'The export of your Centcom data is ready.',
        `Download the export: ${p.url}`,
        `The link expires on ${formatDate(p.expiresAt)}.`,
      ),
  },
});

/** A set of templates; each EmailService has its own (no process-wide registry). */
export interface TemplateRegistry {
  /** Adds a template; a TypeError if the id is taken. */
  registerTemplate<T extends TemplateId>(id: T, template: EmailTemplate<TemplateParams[T]>): void;
  /** The template, or undefined for an unknown id. */
  get(id: string): EmailTemplate<Record<string, unknown>> | undefined;
  /** Every registered id. */
  ids(): string[];
}

/** A registry holding this lane's templates. */
export function createTemplateRegistry(): TemplateRegistry {
  const templates = new Map<string, EmailTemplate<Record<string, unknown>>>(
    Object.entries(BUILT_IN_TEMPLATES) as [string, EmailTemplate<Record<string, unknown>>][],
  );
  return {
    registerTemplate(id, template) {
      if (templates.has(id)) throw new TypeError(`email template ${id} is already registered`);
      templates.set(id, template as unknown as EmailTemplate<Record<string, unknown>>);
    },
    get: (id) => templates.get(id),
    ids: () => [...templates.keys()],
  };
}

/**
 * Renders `template` (id `tag`) with `params`: checks every parameter by its kind first (a 422
 * listing every bad one, pointers `/params/<name>`), escapes every value in the HTML, wraps the
 * body in the layout and adds the footer to the text.
 */
export function renderTemplate(
  tag: string,
  template: EmailTemplate<Record<string, unknown>>,
  params: unknown,
): RenderedContent {
  const values =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const issues: FieldError[] = [];
  for (const [name, kind] of Object.entries(template.params)) {
    const pointer = `/params/${name}`;
    if (kind === 'url') checkUrlParam(values[name], pointer, issues);
    else if (kind === 'date') checkDateParam(values[name], pointer, issues);
    else checkTextParam(values[name], pointer, issues);
  }
  if (issues.length > 0) throw validationFailed(issues, EMAIL_DETAILS.invalid);
  const subject = limitSubject(template.subject(values));
  return {
    subject,
    html: layout(subject, template.html(values)),
    text: `${template.text(values)}\n\n--\n${FOOTER}\n`,
    tag,
  };
}
