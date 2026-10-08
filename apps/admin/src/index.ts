/**
 * @centcom/admin: the internal admin console (B088), a static single-page app over the admin API
 * (B087), served only on the private network. The app's entry is `main.tsx`; this module exposes
 * its API client and helpers for tests and tooling.
 */
export {
  AdminClient,
  INCIDENT_STATUSES,
  type ClientHooks,
  type Fetch,
  type Incident,
  type IncidentStatus,
} from './api/client.js';
export {
  AdminApiError,
  errorFromResponse,
  networkError,
  ReasonCancelledError,
} from './api/errors.js';
export {
  reasonProblem,
  REASON_MAX,
  REASON_MIN,
  ticketProblem,
  toReason,
  type Reason,
} from './api/reason.js';
export { isId, subjectOf } from './api/token.js';
export { ADMIN_PATH, IDLE_SIGN_OUT_MS, type ConsoleConfig } from './config.js';
export { parseRoute, pathOfId, type Route } from './router.js';
