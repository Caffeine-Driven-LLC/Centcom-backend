/**
 * Errors (B006): the CT-ERR registry, typed `AppError`s and their helpers, and `toProblem`, which
 * turns anything thrown into an RFC 9457 problem body. The API's error handler plugin and the
 * relay's `sys.error` frames both build on it.
 */
export {
  codeForStatus,
  ERROR_CODES,
  ERROR_TYPE_BASE,
  errorEntry,
  isErrorCode,
  isErrorStatus,
  isRetryable,
  type ErrorCode,
  type ErrorEntry,
} from './registry.js';
export {
  AppError,
  badRequest,
  conflict,
  forbidden,
  isAppError,
  notFound,
  tooManyRequests,
  unauthorized,
  unavailable,
  unprocessable,
  validationFailed,
  type AppErrorHelperOptions,
  type AppErrorOptions,
  type FieldError,
} from './app-error.js';
export {
  DEFAULT_RETRY_AFTER_S,
  ERROR_DETAILS,
  fallbackProblemBody,
  MAX_FIELD_ERRORS,
  MAX_RETRY_AFTER_S,
  PROBLEM_CONTENT_TYPE,
  toProblem,
  type Problem,
  type ProblemContext,
} from './problem.js';
