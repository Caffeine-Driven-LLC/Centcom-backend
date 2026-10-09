/**
 * Who may list invoices (B077 acceptance 1 and 5, test plan "authz matrix test over all five
 * workspace roles and cross-workspace access"):
 *
 * - owner, admin and billing get 200 with the page; member and guest get 403 `forbidden`; all by
 *   roles from the membership store (B021 RBAC `billing.read`, CT-RBAC's "View billing, invoices"
 *   row: owner, admin and billing), never by a claim in the request. Admin is allowed by CT-RBAC's
 *   matrix, `02-rest-api.md` ("owner/admin/billing") and the 1.1.0 changelog ("invoices readable by
 *   owner/admin/billing"); openapi's `x-role: owner/billing` annotation is the one source that
 *   leaves admin out, and GUIDELINES §5.1 makes the RBAC engine the single authority.
 * - a user of workspace A asking for workspace B's invoices gets 404 and no row data, whichever
 *   role they hold in A; so does an unknown or malformed workspace id;
 * - an API key needs `billing:read` and its own workspace; a token without `billing:read` is 403;
 *   no credentials is 401;
 * - a read writes no audit event (scope_in); a refused one is audited by B021 as
 *   `permission.denied`, as CT-RBAC rule 6 requires for a privileged action.
 */
import { AUDIT_BATCH_INTERVAL_MS, type WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { asKey, asUser, createWorkspace } from '../../modules/workspaces/helpers.js';
import { invoiceOf, listAs, newId, READ, stripeId, withWorkspace } from './helpers.js';

const ROLES: [WorkspaceRole, number][] = [
  ['owner', 200],
  ['admin', 200],
  ['billing', 200],
  ['member', 403],
  ['guest', 403],
];

async function withInvoices() {
  const ctx = await withWorkspace();
  for (const name of ['paid-usd-tax', 'open-eur-vat'] as const) {
    await ctx.service.applyInvoiceEvent(invoiceOf(name, ctx.customer));
  }
  return ctx;
}

describe('GET /v1/workspaces/{id}/invoices: authorization', () => {
  it('answers owner, admin and billing; refuses member and guest with 403 forbidden', async () => {
    const ctx = await withInvoices();
    for (const [role, status] of ROLES) {
      let user = ctx.owner;
      if (role !== 'owner') {
        user = newId('usr');
        ctx.store.join(ctx.ws, user, role);
      }
      const response = await listAs(ctx, ctx.ws, user);
      expect(response.statusCode, role).toBe(status);
      if (status === 200) {
        expect(response.json<{ data: unknown[] }>().data, role).toHaveLength(2);
      } else {
        expect(response.headers['content-type'], role).toMatch(/^application\/problem\+json/);
        expect(response.json<{ code: string }>().code, role).toBe('forbidden');
        expect(response.body, role).not.toContain('amount_due');
      }
    }
    // Reads write no audit event; the two refusals are B021's permission.denied.
    await ctx.emitter.flush(AUDIT_BATCH_INTERVAL_MS * 4);
    expect(ctx.detached.map((r) => [r['action'], r['outcome']])).toEqual([
      ['permission.denied', 'denied'],
      ['permission.denied', 'denied'],
    ]);
    expect(ctx.store.audit.map((r) => String(r['action']))).not.toContainEqual(
      expect.stringMatching(/invoice|billing/),
    );
    await ctx.app.close();
  });

  it('decides by the stored role, never by a claim in the request', async () => {
    const ctx = await withInvoices();
    const member = newId('usr');
    ctx.store.join(ctx.ws, member, 'member');
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${ctx.ws}/invoices`,
      headers: { ...asUser(member, READ), 'x-test-role': 'owner' },
    });
    expect(response.statusCode).toBe(403);
    await ctx.app.close();
  });

  it('hides another workspace: 404 and no row data, whatever role the caller has elsewhere', async () => {
    const ctx = await withInvoices();
    for (const [role] of ROLES) {
      const user = newId('usr');
      ctx.store.addUser(user);
      const own = (await createWorkspace(ctx.app, user, `Own ${role}`)).id;
      if (role !== 'owner') {
        // A member of some other workspace with this role.
        const other = newId('usr');
        ctx.store.addUser(other);
        const theirs = (await createWorkspace(ctx.app, other, `Theirs ${role}`)).id;
        ctx.store.join(theirs, user, role);
      }
      const response = await listAs(ctx, ctx.ws, user);
      expect(response.statusCode, role).toBe(404);
      expect(response.json<{ code: string }>().code, role).toBe('not_found');
      expect(response.body, role).not.toMatch(/amount|invoice_url|FIXTURE/);
      expect((await listAs(ctx, own, user)).statusCode, role).toBe(200);
    }
    for (const id of [newId('wsp'), 'wsp_nope', newId('usr')]) {
      expect((await listAs(ctx, id, ctx.owner)).statusCode, id).toBe(404);
    }
    await ctx.app.close();
  });

  it("lists only the workspace's own invoices", async () => {
    const ctx = await withInvoices();
    const ws2 = (await createWorkspace(ctx.app, ctx.owner, 'Second')).id;
    const customer2 = stripeId('cus');
    ctx.billing.customers.set(ws2, customer2);
    await ctx.service.applyInvoiceEvent(invoiceOf('void-usd', customer2));
    const first = (await listAs(ctx, ctx.ws, ctx.owner)).json<{ data: { status: string }[] }>();
    const second = (await listAs(ctx, ws2, ctx.owner)).json<{ data: { status: string }[] }>();
    expect(first.data.map((i) => i.status).sort()).toEqual(['open', 'paid']);
    expect(second.data.map((i) => i.status)).toEqual(['void']);
    await ctx.app.close();
  });

  it('needs billing:read, and an API key of the workspace itself', async () => {
    const ctx = await withInvoices();
    const url = `/v1/workspaces/${ctx.ws}/invoices`;
    const get = (headers?: Record<string, string>) =>
      ctx.app.inject({ method: 'GET', url, ...(headers === undefined ? {} : { headers }) });
    expect((await get(asUser(ctx.owner, 'workspaces:read'))).statusCode).toBe(403);
    expect((await get(asKey(ctx.ws, READ))).statusCode).toBe(200);
    expect((await get(asKey(ctx.ws, 'workspaces:read'))).statusCode).toBe(403);
    expect((await get(asKey(newId('wsp'), READ))).statusCode).toBe(404);
    const unauthenticated = await get();
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['content-type']).toMatch(/^application\/problem\+json/);
    await ctx.app.close();
  });
});
