-- Confirms the layer-2 safety objects survived the last migration.
-- If any count drops, a migration was applied without its hand-written SQL.
-- See MIGRATIONS.md.

\set ON_ERROR_STOP on
\pset format aligned

select
  label,
  actual,
  expected,
  case when actual >= expected then 'ok' else 'MISSING' end as status
from (
  select 'check constraints'  as label,
         (select count(*) from pg_constraint
           where contype = 'c' and connamespace = 'public'::regnamespace) as actual,
         27 as expected
  union all
  select 'partial indexes',
         (select count(*) from pg_index i
            join pg_class c on c.oid = i.indexrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and i.indpred is not null), 15
  union all
  select 'triggers',
         (select count(*) from pg_trigger where not tgisinternal), 24
  union all
  select 'tables with RLS enabled',
         (select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relrowsecurity), 16
  union all
  select 'RLS policies',
         (select count(*) from pg_policies where schemaname = 'public'), 49
  union all
  select 'app schema functions',
         (select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app'), 12
) t
order by status desc, label;

-- Any view lacking security_invoker silently bypasses RLS for everything it
-- reads, so this must return no rows.
\echo ''
\echo 'Views missing security_invoker (must be empty):'
select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'v'
   and (c.reloptions is null
        or not ('security_invoker=true' = any(c.reloptions)));
