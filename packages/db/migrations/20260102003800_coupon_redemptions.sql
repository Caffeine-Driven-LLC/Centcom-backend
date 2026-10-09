-- Trials, coupons and promotions (B079, CT-API-BILLING `redeemCoupon`).
--
-- - coupon_redemptions: the ledger of promotion codes applied to a workspace's subscription, for
--   audit, abuse detection and replay. `code_hash` is the sha256 (hex) of the normalised code
--   (trimmed, upper case): the code itself is never stored. `stripe_promotion_id` is Stripe's
--   `promo_…`; `UNIQUE(workspace_id, stripe_promotion_id)` records a promotion at most once per
--   workspace, also under concurrent requests. A row is written after Stripe applied the
--   promotion, with its audit event, in one short transaction (no transaction waits on Stripe).
--   `user_id` is the redeeming user (null for a staff grant, B087, an API key, or a deleted
--   account); `request_fingerprint` the sha256 (hex) of the request's Idempotency-Key, else of
--   its request id, so a retry of the request that wrote the row answers as it did. `id` is a
--   bare ULID (CT-IDS defines no prefix). Rows go with their workspace (B027's purge).
-- - billing_trials: the trials Stripe confirmed (a subscription seen `trialing`), one per
--   workspace. It outlives its workspace (`workspace_id` is set null when the workspace is
--   purged), or a deleted and recreated workspace would get a second trial.
-- - billing_trial_owners: every owner of the workspace when its trial was recorded, so each of
--   them gets one trial. A row goes with its trial, or with the user's account (B026).
--
-- Retention (B090): trials and their owners 24 months after the trial ended, or after it was
-- recorded when Stripe gave no end.
--
-- Named after main's newest migration (20260102003700, B077) instead of the card's
-- 079_coupon_redemptions.sql, which the runner's file pattern refuses.

create table coupon_redemptions (
  id text primary key check (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  user_id text references users (id) on delete set null,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  stripe_promotion_id text not null check (stripe_promotion_id ~ '^promo_[A-Za-z0-9]{1,250}$'),
  redeemed_at timestamptz not null default now(),
  request_fingerprint text check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint coupon_redemptions_workspace_id_stripe_promotion_id_key
    unique (workspace_id, stripe_promotion_id)
);

-- Abuse detection: who redeemed which code.
create index coupon_redemptions_code_hash_idx on coupon_redemptions (code_hash);
create index coupon_redemptions_user_id_idx on coupon_redemptions (user_id);

create table billing_trials (
  stripe_subscription_id text primary key
    check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  workspace_id text unique references workspaces (id) on delete set null,
  trial_end timestamptz,
  created_at timestamptz not null default now()
);

create table billing_trial_owners (
  stripe_subscription_id text not null
    references billing_trials (stripe_subscription_id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (stripe_subscription_id, user_id)
);

-- One trial per owner: trialEligibility looks the owners up.
create index billing_trial_owners_user_id_idx on billing_trial_owners (user_id);

-- rollback note: drop table billing_trial_owners; drop table billing_trials; drop table
-- coupon_redemptions; the promotions stay on the Stripe subscriptions, but the one-per-workspace
-- ledger and the trial history are lost (a workspace or owner could get a second trial).
