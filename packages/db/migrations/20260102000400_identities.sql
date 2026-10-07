-- identities (B015): which external account (GitHub, Google) signs in as which user.
--
-- Only the provider and the provider's stable account id are kept: no provider access, ID or
-- refresh token, authorization code or e-mail address is ever stored. A row is created when an
-- account first signs in (linked to the user with its verified e-mail, or to a new user) and
-- keeps pointing at that user even if the account's e-mail changes at the provider. Rows are
-- never exposed through the API, so the key is the natural (provider, subject) pair, not a
-- CT-IDS id. Retention: deleted with the user's account (B026).

create table identities (
  provider text not null check (provider in ('github', 'google')),
  -- GitHub's numeric user id or Google's `sub`: stable for the account's lifetime.
  subject text not null check (char_length(subject) between 1 and 255),
  user_id text not null references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);

create index identities_user_id_idx on identities (user_id);

-- rollback note: nothing references identities; drop the table (accounts then sign in again and
-- are matched to users by their verified e-mail).
