-- login_tokens (B014): one-time e-mail sign-in links.
--
-- Only hashes are kept: `token_hash` is sha256 of the 256-bit token in the link, `nonce_hash` the
-- sha256 of the nonce in the requesting browser's cookie (a link works only in that browser). The
-- e-mail address is kept because signing in needs it; the row lives 15 minutes, is used at most
-- once (`used_at`), and expired or used rows are purged by the retention lane (B090). Rows are
-- never exposed through the API, so the key is the token hash, not a CT-IDS id.
--
-- Named after 20260102000400_identities: the runner refuses a file older than an applied one.

create table login_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  email text not null check (char_length(email) between 3 and 254),
  return_to text not null check (char_length(return_to) between 1 and 2048),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set from the API's clock (not now()), like the expiry checks, so the two always agree.
  used_at timestamptz
);

create index login_tokens_expires_at_idx on login_tokens (expires_at);

-- rollback note: nothing references login_tokens; drop the table (links in flight then fail and
-- users ask for new ones).
