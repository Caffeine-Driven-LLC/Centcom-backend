-- half_done: creates a table and a row, then fails, so nothing of it may remain.
create table half_done (id text primary key);
insert into half_done (id) values ('row-1');
select 1 / 0;

-- rollback note: nothing to undo; the runner rolls the whole file back.
