/**
 * Errors of admin API calls (B088): a problem+json answer (CT-ERR) becomes an `AdminApiError` with
 * its status, code, title, detail and request id; a network failure is status 0. A call the staff
 * member declined to give a reason for is a `ReasonCancelledError`, and nothing was sent.
 */

/** A failed admin API call. */
export class AdminApiError extends Error {
  constructor(
    /** The HTTP status; 0 when the API could not be reached. */
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail: string | null,
    /** The `req_` id to quote to whoever looks at the logs. */
    readonly requestId: string | null,
  ) {
    super(`${status} ${code}`);
    this.name = 'AdminApiError';
  }
}

/** The staff member cancelled the reason dialog: the call was not sent. */
export class ReasonCancelledError extends Error {
  constructor() {
    super('No reason was given, so nothing was sent.');
    this.name = 'ReasonCancelledError';
  }
}

const REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value !== '' ? value.slice(0, max) : null;

/** The error of a non-2xx answer, from its problem+json body when it has one. */
export async function errorFromResponse(res: Response): Promise<AdminApiError> {
  const headerId = res.headers.get('x-request-id');
  let body: Record<string, unknown> = {};
  if (/json/i.test(res.headers.get('content-type') ?? '')) {
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      // Not JSON after all: the status alone will do.
    }
  }
  const requestId = [body['request_id'], headerId].find(
    (id): id is string => typeof id === 'string' && REQUEST_ID.test(id),
  );
  return new AdminApiError(
    res.status,
    text(body['code'], 64) ?? (res.status >= 500 ? 'server_error' : 'request_failed'),
    text(body['title'], 200) ?? `The admin API answered ${res.status}.`,
    text(body['detail'], 500),
    requestId ?? null,
  );
}

/** The error of a call that never got an answer. */
export const networkError = (): AdminApiError =>
  new AdminApiError(0, 'network_error', 'The admin API could not be reached.', null, null);
