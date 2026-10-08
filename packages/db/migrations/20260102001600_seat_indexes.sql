-- Seat counting (B030, CT-ENTITLEMENTS): the seat gate counts a workspace's seat-taking memberships
-- and its pending invites (not accepted, revoked or expired) inside the transaction that adds a
-- member, under a per-workspace advisory lock. This partial index keeps the pending-invite count a
-- short index range scan however many old invites a workspace has.
--
-- The card also asks for an index on memberships (workspace_id). None is added: the unique
-- constraint memberships_workspace_id_user_id_key (B008) is an index led by workspace_id and already
-- serves that lookup, and a second one would only cost writes.
--
-- Named after main's newest migration (20260102001500, B069) instead of the card's 0030_*.

create index invites_workspace_id_pending_idx on invites (workspace_id, expires_at)
  where accepted_at is null and revoked_at is null and expired_at is null;

-- rollback note: drop index if exists invites_workspace_id_pending_idx; nothing depends on it.
