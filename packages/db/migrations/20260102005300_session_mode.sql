-- sessions.mode (B110, CT-API-SESSIONS `mode`, CT-WS-SESSION-EVENTS `*` notes): how a session's
-- agents run. `command_post`: only the host runs agents and emits their events; everyone else
-- sends requests through the queue. `branch`: every member runs their own agents, on their own
-- computer, and emits the events for them.
--
-- Chosen when the session is created and never changed (agents, locks and queue items of one mode
-- must not be live in the other), so the relay may cache it for the session's life. Every
-- existing session is a command post.
alter table sessions
  add column mode text not null default 'command_post'
  check (mode in ('command_post', 'branch'));

-- rollback note: alter table sessions drop column mode; (after a "-- contract" line, and only when no branch session exists)
