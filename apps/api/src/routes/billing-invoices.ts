/**
 * `GET /v1/workspaces/{id}/invoices` (B077, CT-API-BILLING `listInvoices`), scope `billing:read`:
 *
 * - The workspace's owner, admins and billing members get 200 with a CT-PAGE page of its invoices
 *   (`limit` 1 to 200, default 50; newest first: `created_at`, then id). Members and guests get
 *   403; anyone else (and an unknown or malformed id) 404, by B021's RBAC on roles read from the
 *   database (`billing.read`, CT-RBAC "View billing, invoices"). An API key needs `billing:read`
 *   and its own workspace.
 * - Cursors are bound to the workspace: one from another workspace's list, or older than 24 h,
 *   is a 400 `cursor_invalid` (CT-PAGE).
 * - Each invoice is the contract's `Invoice`: never a Stripe customer id, a payment id, card data
 *   or a raw Stripe object.
 * - It answers from the mirror; a stale mirror is refreshed lazily, and only a workspace's first
 *   sync is waited for, at most 2 s (see `InvoiceService.list`).
 * - `Cache-Control: private, no-store`: the hosted invoice links open the invoice page, so the
 *   answer is not kept on disk.
 *
 * Register after the request-context, error-handler, auth and RBAC plugins.
 *
 * Owns: the HTTP side. Must not: call Stripe itself, or decide who may read invoices.
 */
import { defineFilters, idFilter, parsePageQuery, type SigningKeys } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import type { InvoiceService } from '../modules/billing/invoices/service.js';
import { workspaceAccess } from '../modules/workspaces/access.js';
import { requireScope } from '../plugins/rbac.js';

/** Options for `invoiceRoutes`. */
export interface InvoiceRouteOptions {
  invoices: Pick<InvoiceService, 'list'>;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
/** What a cursor is bound to: the workspace whose list it pages. */
const CURSOR_FILTERS = defineFilters({ workspace: idFilter('wsp') });

export const invoiceRoutes: FastifyPluginAsync<InvoiceRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;

  app.get(
    '/v1/workspaces/:id/invoices',
    { preHandler: requireScope('billing:read') },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'billing.read');
      const query = parsePageQuery(request.query, LIST_SPEC);
      const page = await opts.invoices.list(workspaceId, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        sort: query.sort,
        filterHash: CURSOR_FILTERS.hash({ workspace: workspaceId }),
        keys: opts.cursorKeys,
        now: clock(),
      });
      reply.header('cache-control', 'private, no-store');
      return page;
    },
  );
};
