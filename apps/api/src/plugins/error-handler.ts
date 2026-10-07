/**
 * Error handler plugin (B006): every error and every unmatched request leaves the API as an
 * RFC 9457 `application/problem+json` response (CT-ERR) with a registry code, the request id and,
 * where CT-ERR rule 6 asks for them, `retry_after_s` and `Retry-After`. A URL that exists only
 * under other methods answers 405 with `Allow`. Routes registered after the plugin get the CT-PAGE
 * JSON body limit (256 KiB) unless they set their own. `frameworkErrorHandler` covers the errors
 * Fastify raises before routing, such as a malformed URL.
 *
 * Owns: mapping thrown errors and Fastify's own errors to problems, the 404/405 handler, the
 * default body limit and the `http.error` log line. Must not: put an error's message or stack, the
 * request body, header values or the URL into a response, or write a second response after the
 * first one has started.
 */
import { isId, newId } from '@centcom/contracts';
import {
  AppError,
  codeForStatus,
  DEFAULT_RETRY_AFTER_S,
  ERROR_DETAILS,
  fallbackProblemBody,
  getRequestContext,
  isErrorCode,
  isErrorStatus,
  PROBLEM_CONTENT_TYPE,
  runWithContext,
  toProblem,
  type ErrorCode,
  type FieldError,
  type LogFields,
  type Logger,
  type Problem,
} from '@centcom/core';
import type {
  FastifyError,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
  HTTPMethods,
} from 'fastify';
import { clientRequestId, REQUEST_ID_HEADER, UNMATCHED_ROUTE } from './request-context.js';

/** CT-PAGE: JSON request bodies are at most 256 KiB, except on routes that set their own `bodyLimit`. */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

/** Options for `errorHandlerPlugin`. */
export interface ErrorHandlerOptions {
  /** Writes the `http.error` lines. */
  logger: Logger;
  /** Body limit, in bytes, of routes registered after the plugin that set none; default 256 KiB. */
  bodyLimit?: number;
  /**
   * Makes an id for a request that has no valid `req_` id yet (an error raised before the request
   * context plugin ran); default `newId('req')`.
   */
  newRequestId?: () => string;
}

/** Options for `frameworkErrorHandler`. */
export type FrameworkErrorOptions = Pick<ErrorHandlerOptions, 'logger' | 'newRequestId'>;

/** Fastify's own errors with a fixed code and detail. The rest map by their status. */
const FASTIFY_ERRORS: ReadonlyMap<string, { code: ErrorCode; detail: string }> = new Map([
  [
    'FST_ERR_CTP_INVALID_JSON_BODY',
    { code: 'invalid_request', detail: ERROR_DETAILS.malformedJson },
  ],
  ['FST_ERR_CTP_EMPTY_JSON_BODY', { code: 'invalid_request', detail: ERROR_DETAILS.emptyJsonBody }],
  [
    'FST_ERR_CTP_INVALID_CONTENT_LENGTH',
    { code: 'invalid_request', detail: ERROR_DETAILS.contentLengthMismatch },
  ],
  [
    'FST_ERR_CTP_BODY_TOO_LARGE',
    { code: 'payload_too_large', detail: ERROR_DETAILS.payloadTooLarge },
  ],
  [
    'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    { code: 'unsupported_media_type', detail: ERROR_DETAILS.unsupportedMediaType },
  ],
  ['FST_ERR_BAD_URL', { code: 'invalid_request', detail: ERROR_DETAILS.badUrl }],
  // 414 URI Too Long has no registry code: it goes out as 414 with `invalid_request` (CT-ERR rule 7).
  ['FST_ERR_MAX_PARAM_LENGTH', { code: 'invalid_request', detail: ERROR_DETAILS.uriTooLong }],
  ['FST_ERR_NOT_FOUND', { code: 'not_found', detail: ERROR_DETAILS.notFound }],
]);

/** True for an error Fastify itself raised (its codes start with `FST_`). */
function isFastifyError(error: unknown): error is FastifyError {
  return (
    error instanceof Error &&
    typeof (error as Partial<FastifyError>).code === 'string' &&
    (error as FastifyError).code.startsWith('FST_')
  );
}

const escapePointerToken = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Field errors of a route schema failure. Routes validate with the `@centcom/contracts` validators
 * (GUIDELINES §3.2), so this only covers a route that declared a Fastify schema. Pointers are
 * relative to the validated part (body, query, params or headers); Ajv's messages are not copied.
 */
function schemaFieldErrors(error: FastifyError): FieldError[] {
  return (error.validation ?? []).map((issue) => {
    const missing = issue.keyword === 'required' ? issue.params['missingProperty'] : undefined;
    return typeof missing === 'string'
      ? { pointer: `${issue.instancePath}/${escapePointerToken(missing)}`, code: 'required' }
      : { pointer: issue.instancePath, code: 'invalid' };
  });
}

/** The AppError a Fastify error stands for. Its message, which can quote the URL, is not kept. */
function fromFastifyError(error: FastifyError): AppError {
  if (error.code === 'FST_ERR_VALIDATION') {
    return new AppError('validation_failed', {
      detail: ERROR_DETAILS.schemaMismatch,
      errors: schemaFieldErrors(error),
    });
  }
  const status = isErrorStatus(error.statusCode) ? error.statusCode : 500;
  const known = FASTIFY_ERRORS.get(error.code);
  if (known !== undefined) return new AppError(known.code, { detail: known.detail, status });
  const detail = status < 500 ? ERROR_DETAILS.badRequest : ERROR_DETAILS.internal;
  return new AppError(codeForStatus(status), { detail, status });
}

/** Sends `problem` as `application/problem+json`, with `Retry-After` when it carries `retry_after_s`. */
function sendProblem(
  reply: FastifyReply,
  problem: Problem,
  headers: Readonly<Record<string, string>>,
): void {
  // A Buffer, because Fastify appends "; charset=utf-8" to the content type of a string body.
  const body = Buffer.from(JSON.stringify(problem));
  reply.code(problem.status).header('content-type', PROBLEM_CONTENT_TYPE);
  if (problem.retry_after_s !== undefined) {
    reply.header('retry-after', String(problem.retry_after_s));
  }
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  reply.send(body);
}

/** Turns an error into the response; never throws. `headers` are added to the problem response. */
type Responder = (
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  headers?: Readonly<Record<string, string>>,
) => void;

/** The responder shared by the error handler, the 404/405 handler and `frameworkErrorHandler`. */
function createResponder(options: FrameworkErrorOptions): Responder {
  const { logger } = options;
  const newRequestId = options.newRequestId ?? (() => newId('req'));

  /**
   * The request's id. One that has no valid `req_` id yet (the error came before the request
   * context plugin's hook) gets the client's valid `X-Request-Id` or a new id, echoed in the header.
   */
  const requestIdOf = (request: FastifyRequest, reply: FastifyReply): string => {
    if (isId('req', request.id)) return request.id;
    const id = clientRequestId(request.headers[REQUEST_ID_HEADER]) ?? newRequestId();
    request.id = id;
    reply.header(REQUEST_ID_HEADER, id);
    return id;
  };

  /** Logs inside the request's context, so the line carries its request id even before routing. */
  const log = (requestId: string, level: 'error' | 'debug', fields: LogFields): void => {
    runWithContext({ ...getRequestContext(), requestId }, () =>
      logger[level](fields, 'http.error'),
    );
  };

  const lineFields = (request: FastifyRequest, status: number): Record<string, unknown> => ({
    status,
    method: request.method,
    route: request.routeOptions.url ?? UNMATCHED_ROUTE,
  });

  /** The static 500 for when building or sending the real problem failed. */
  const fallback = (failure: unknown, request: FastifyRequest, reply: FastifyReply): void => {
    const requestId = isId('req', request.id) ? request.id : newId('req');
    try {
      log(requestId, 'error', { ...lineFields(request, 500), err: failure, handler_failed: true });
    } catch {
      // The response matters more than the log line.
    }
    try {
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      reply
        .code(500)
        .header('content-type', PROBLEM_CONTENT_TYPE)
        .header('retry-after', String(DEFAULT_RETRY_AFTER_S))
        .header(REQUEST_ID_HEADER, requestId)
        .send(Buffer.from(fallbackProblemBody(requestId)));
    } catch {
      reply.raw.destroy();
    }
  };

  return (error, request, reply, headers = {}) => {
    try {
      const requestId = requestIdOf(request, reply);
      if (reply.sent || reply.raw.headersSent) {
        // Part of a response is already out: a second one would corrupt it. Cut the connection so
        // the client sees a broken response rather than a truncated one it might trust.
        log(requestId, 'error', {
          ...lineFields(request, reply.raw.statusCode),
          err: error,
          response_started: true,
        });
        reply.raw.destroy();
        return;
      }
      const fastifyError = isFastifyError(error);
      const appError =
        error instanceof AppError ? error : fastifyError ? fromFastifyError(error) : error;
      const route = request.routeOptions.url;
      const problem = toProblem(
        appError,
        route === undefined ? { requestId } : { requestId, instance: route },
      );
      const fields = { ...lineFields(request, problem.status), error_code: problem.code };
      if (fastifyError) {
        // Fastify's messages can quote the URL or a header, so only its code is logged.
        log(requestId, problem.status >= 500 ? 'error' : 'debug', {
          ...fields,
          fastify_code: error.code,
        });
      } else if (!(appError instanceof AppError) || !isErrorCode(appError.code)) {
        // An unexpected error, or a code missing from the registry (CT-ERR rule 7): a bug to fix.
        log(requestId, 'error', { ...fields, err: error, unexpected: true });
      } else {
        log(requestId, problem.status >= 500 ? 'error' : 'debug', { ...fields, err: error });
      }
      sendProblem(reply, problem, headers);
    } catch (failure) {
      fallback(failure, request, reply);
    }
  };
}

const plugin: FastifyPluginAsync<ErrorHandlerOptions> = async (fastify, options) => {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
    throw new TypeError('errorHandlerPlugin: bodyLimit must be a positive integer');
  }
  const respond = createResponder(options);
  /** Every method some route answers, to tell a 405 from a 404. */
  const methods = new Set<HTTPMethods>();

  fastify.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      methods.add(method);
    }
    // Fastify validates a route's own bodyLimit before this hook; ours was checked above.
    if (route.bodyLimit === undefined) route.bodyLimit = bodyLimit;
  });

  fastify.setErrorHandler((error, request, reply) => {
    respond(error, request, reply);
  });

  fastify.setNotFoundHandler((request, reply) => {
    // The router matches the concrete URL, so `/v1/sessions/ses_…` finds `/v1/sessions/:id`.
    const allow = [...methods]
      .filter(
        (method) =>
          method !== request.method && fastify.findRoute({ method, url: request.url }) !== null,
      )
      .sort();
    if (allow.length === 0) {
      respond(new AppError('not_found', { detail: ERROR_DETAILS.notFound }), request, reply);
      return;
    }
    const methodNotAllowed = new AppError(codeForStatus(405), {
      status: 405,
      detail: ERROR_DETAILS.methodNotAllowed,
    });
    respond(methodNotAllowed, request, reply, { allow: allow.join(', ') });
  });
};

/**
 * Registers the error handler, the 404/405 handler and the default body limit on the whole Fastify
 * instance (not just the plugin's encapsulation context). Register it after the request context
 * plugin and before any route: routes registered earlier keep Fastify's 1 MiB limit and are left
 * out of the 405 check.
 */
export const errorHandlerPlugin: FastifyPluginAsync<ErrorHandlerOptions> = Object.assign(plugin, {
  // Fastify's documented alternative to fastify-plugin: apply the handlers to the parent instance.
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-error-handler',
});

/**
 * Fastify's `frameworkErrors` server option: answers the errors Fastify raises before routing (a
 * malformed or overlong URL, a failing async constraint) with a problem too. No hook has run for
 * them, so the request id comes from here. Pass it when creating the server:
 * `fastify({ frameworkErrors: frameworkErrorHandler({ logger }) })`.
 */
export function frameworkErrorHandler(
  options: FrameworkErrorOptions,
): NonNullable<FastifyServerOptions['frameworkErrors']> {
  const respond = createResponder(options);
  return (error, request, reply) => {
    respond(error, request, reply);
  };
}
