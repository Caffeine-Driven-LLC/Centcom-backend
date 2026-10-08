-- session_member_slots (B031, CT-WS-SESSION-EVENTS "Member slots and colours"): each member's
-- slot in a session. The first member gets 0, the next 1, and so on; a slot is never given to
-- another member of the same session, even after its holder left or was kicked, and a member who
-- comes back gets theirs again. 50 members at most (slots 0-49). Ids only: no names or colours
-- (colours are a client presentation rule).
--
-- The relay assigns slots before it writes the member's session_members row, so member_id is the
-- CT-IDS `mem_` id with no foreign key. A session's slots are deleted by the retention job
-- (`deleteForSession`) before the session row.
--
-- Named after 20260102002900_staff_users, the newest migration on main when this file was
-- renamed: the runner refuses a file older than an applied one (and 20260102003000 and
-- 20260102003200 are taken by lanes in review).

create table session_member_slots (
  session_id text not null references sessions (id) on delete restrict,
  member_id text not null check (member_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  slot integer not null check (slot between 0 and 49),
  assigned_at timestamptz not null default now(),
  constraint session_member_slots_pkey primary key (session_id, member_id),
  constraint session_member_slots_session_id_slot_key unique (session_id, slot)
);

-- rollback note: nothing references session_member_slots; drop the table (the relay then has no
-- slots to hand out until it is restored, and clients show members without colours).
