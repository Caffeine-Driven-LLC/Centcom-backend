-- add_widget_color: an additive change to an existing table.
alter table widgets add column color text;
create index widgets_color_idx on widgets (color);

-- rollback note: drop index widgets_color_idx, then drop the column in a contract migration.
