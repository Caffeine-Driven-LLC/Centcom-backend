-- create_gadgets: a table referencing the first one.
create table gadgets (
  id text primary key,
  widget_id text not null references widgets (id),
  created_at timestamptz not null default now()
);
create index gadgets_widget_id_idx on gadgets (widget_id);

-- rollback note: drop table gadgets.
