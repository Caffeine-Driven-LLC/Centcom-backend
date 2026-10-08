/**
 * The reason and ticket every admin API call carries (B087: `X-Admin-Reason`, 10-500 characters;
 * `X-Admin-Ticket`, 1-64 of `[A-Za-z0-9._#:/-]`). Checked here first so the console never sends a
 * call the API would refuse for them. Header values must be Latin-1 (the Fetch API refuses
 * anything else), so the reason is printable Latin-1.
 */

/** Why the staff member is looking, and the ticket it is for. */
export interface Reason {
  reason: string;
  ticket: string | null;
}

export const REASON_MIN = 10;
export const REASON_MAX = 500;
const PRINTABLE_LATIN1 = /^[\x20-\x7e\xa0-\xff]*$/;
const TICKET = /^[A-Za-z0-9._#:/-]{1,64}$/;

/** What is wrong with `text` as a reason, or null when it is fine. */
export function reasonProblem(text: string): string | null {
  const reason = text.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`;
  }
  if (!PRINTABLE_LATIN1.test(reason)) {
    return 'Use letters, digits and punctuation only (no line breaks or emoji).';
  }
  return null;
}

/** What is wrong with `text` as a ticket (empty is fine: it is optional), or null. */
export function ticketProblem(text: string): string | null {
  const ticket = text.trim();
  if (ticket === '' || TICKET.test(ticket)) return null;
  return 'A ticket is 1 to 64 letters, digits or . _ # : / -';
}

/** The reason and ticket from form input; null when either has a problem. */
export function toReason(reason: string, ticket: string): Reason | null {
  if (reasonProblem(reason) !== null || ticketProblem(ticket) !== null) return null;
  const t = ticket.trim();
  return { reason: reason.trim(), ticket: t === '' ? null : t };
}
