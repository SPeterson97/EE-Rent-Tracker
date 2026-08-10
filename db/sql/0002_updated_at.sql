-- 0002_updated_at.sql — layer 2 for the updated_at migration.
--
-- Prisma's @updatedAt only fires when the write goes through Prisma Client.
-- Migrations, admin psql sessions, and background jobs using $executeRaw all
-- bypass it, so the database trigger is the authoritative writer and Prisma's
-- value is simply overwritten with the same instant.
--
-- ledger_entry and auth_code deliberately have no updated_at: ledger_entry is
-- append-only (a trigger rejects UPDATE outright) and auth_code rows are
-- single-use and short-lived.

create or replace function app.touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attach to every table that has the column. Driven off the catalog rather
-- than a hardcoded list so this cannot silently miss a table.
do $$
declare
  t record;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name  = 'updated_at'
       and tb.table_type  = 'BASE TABLE'
     order by c.table_name
  loop
    if not exists (
      select 1 from pg_trigger
       where tgname = t.table_name || '_touch_updated_at'
         and not tgisinternal
    ) then
      execute format(
        'create trigger %I before update on public.%I
           for each row execute function app.touch_updated_at()',
        t.table_name || '_touch_updated_at', t.table_name);
    end if;
  end loop;
end $$;
