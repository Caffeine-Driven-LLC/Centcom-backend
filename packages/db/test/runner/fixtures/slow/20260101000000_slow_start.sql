-- slow_start: takes half a second, so a second migrate arrives while the lock is held.
create table runs (n int not null);
insert into runs (n) values (1);
select pg_sleep(0.5);

-- rollback note: drop table runs.
