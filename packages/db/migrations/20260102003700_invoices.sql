-- Invoices (B077, CT-API-BILLING `listInvoices`): a mirror of each workspace's Stripe invoices,
-- cheap to page and safe to show. Stripe keeps the invoices themselves, the card, the address and
-- the tax ids; the mirror keeps what the list shows and what decides whether an update is newer.
--
-- - invoices: one row per Stripe invoice. `id` is the public, opaque id (a bare ULID: CT-IDS
--   defines no invoice prefix); `stripe_invoice_id` is never shown. Money is integer minor units in
--   USD or EUR (CT-IDS; an invoice in another currency is never stored). `tax_rates` is the tax
--   rate summary: per tax line (at most 20), its amount, taxable amount, inclusive flag,
--   taxability reason and effective rate in basis points; never a tax-rate id. `status` is the
--   contract's, or `other` for a status Stripe adds later (never listed). `created_at` is when
--   Stripe created the invoice (the list's order). `stripe_version` (Unix seconds: the newest of
--   the invoice's creation, its status transitions and when the state was read: the reporting
--   event's time, or the sync's) is the stale-update guard; with the status rank (draft, open,
--   uncollectible, then paid or void, which are final), it keeps a late update from moving an
--   invoice back.
-- - invoice_syncs: when the list's lazy sync last called Stripe for a workspace (at most once per
--   5 minutes, claimed here so concurrent API processes share one call) and last succeeded.
--
-- Rows go with their workspace (B027's purge); the retention rule is the workspace's. Named after
-- main's newest migration (20260102003600, B055) instead of the card's 077_invoices.sql, which the
-- runner's file pattern refuses.

create table invoices (
  id text primary key check (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  stripe_invoice_id text not null unique check (stripe_invoice_id ~ '^in_[A-Za-z0-9]{1,250}$'),
  number text check (char_length(number) between 1 and 100),
  status text not null
    check (status in ('draft', 'open', 'paid', 'void', 'uncollectible', 'other')),
  currency text not null check (currency in ('USD', 'EUR')),
  amount_due_minor bigint not null check (amount_due_minor >= 0),
  amount_paid_minor bigint not null check (amount_paid_minor >= 0),
  tax_minor bigint,
  tax_rates jsonb check (tax_rates is null or jsonb_typeof(tax_rates) = 'array'),
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null,
  paid_at timestamptz,
  hosted_url text check (char_length(hosted_url) <= 2048 and hosted_url ~ '^https://'),
  pdf_url text check (char_length(pdf_url) <= 2048 and pdf_url ~ '^https://'),
  stripe_version bigint not null check (stripe_version >= 0),
  updated_at timestamptz not null default now(),
  check (period_start is null or period_end is null or period_start <= period_end)
);

-- The list: a workspace's invoices, newest first.
create index invoices_workspace_id_created_at_id_idx on invoices (workspace_id, created_at desc, id desc);

create table invoice_syncs (
  workspace_id text primary key references workspaces (id) on delete cascade,
  attempted_at timestamptz not null,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- rollback note: drop table invoice_syncs; drop table invoices; nothing is lost, the next invoice
-- list of each workspace fills the mirror again from Stripe.
