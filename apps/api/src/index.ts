/**
 * @centcom/api: Fastify REST API (/v1/*).
 *
 * The package surface other workspaces use: the admin API's request and response bodies (B087),
 * type-only, for the admin console (B088). Modules are wired by the API's entrypoint, not here.
 */
export type * from './modules/admin/types.js';
