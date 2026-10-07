-- create_widgets: a sample table for the runner tests.
create table widgets (
  id text primary key,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);

-- rollback note: drop table widgets; nothing else uses it.
