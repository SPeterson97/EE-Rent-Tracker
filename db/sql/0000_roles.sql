-- 0000_roles.sql — one-time bootstrap, run BEFORE the first migration.
--
-- Postgres roles are cluster-wide, not per-database, so this cannot live in a
-- Prisma migration: migrations run inside a database and are replayed per
-- environment, whereas roles are created once per server.
--
-- Two roles, and the split is the entire basis of tenant isolation:
--
--   ee_owner  owns the tables. Runs migrations and trusted server-side jobs.
--             BYPASSES RLS, because Postgres exempts table owners by default.
--   ee_app    owns nothing. This is what the running application connects as,
--             and the only role that RLS policies actually constrain.
--
-- Usage (passwords come from the environment, never from this file):
--
--   psql -d ee_rent_tracker \
--     -v owner_password="$EE_OWNER_PASSWORD" \
--     -v app_password="$EE_APP_PASSWORD" \
--     -v ON_ERROR_STOP=1 \
--     -f db/sql/0000_roles.sql
--
-- Safe to re-run: existing roles are left alone (see "Rotating a password"
-- in MIGRATIONS.md to change one deliberately).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Roles
--
-- \gexec runs the generated statement. psql does not interpolate variables
-- inside dollar-quoted blocks, so a DO block cannot be used for this.
-- ---------------------------------------------------------------------------

select format('create role ee_owner login password %L', :'owner_password')
 where not exists (select 1 from pg_roles where rolname = 'ee_owner')
\gexec

select format('create role ee_app login password %L', :'app_password')
 where not exists (select 1 from pg_roles where rolname = 'ee_app')
\gexec

-- Neither role is a superuser and neither has BYPASSRLS. ee_owner's exemption
-- comes only from table ownership, which keeps it scoped to this schema.
alter role ee_owner nosuperuser nocreaterole nobypassrls;
alter role ee_app   nosuperuser nocreatedb nocreaterole nobypassrls;

-- ---------------------------------------------------------------------------
-- Database ownership
--
-- Run once per database, including the shadow database Prisma uses to detect
-- drift when generating migrations.
-- ---------------------------------------------------------------------------

select format('alter database %I owner to ee_owner', current_database())
\gexec

select format('grant connect on database %I to ee_app', current_database())
\gexec

-- ---------------------------------------------------------------------------
-- Schema privileges
--
-- ee_app may read and write rows but must never create, alter, or drop
-- objects — schema changes belong to migrations running as ee_owner.
-- ---------------------------------------------------------------------------

revoke create on schema public from public;
revoke create on schema public from ee_app;

grant usage on schema public to ee_app;

-- Existing objects. Tables created by later migrations are covered by the
-- default privileges below.
grant select, insert, update, delete on all tables    in schema public to ee_app;
grant usage, select                  on all sequences in schema public to ee_app;

-- Applies only to objects subsequently created BY ee_owner, which is why
-- migrations must always run as ee_owner. A migration applied as any other
-- role produces tables ee_app cannot see at all.
alter default privileges for role ee_owner in schema public
  grant select, insert, update, delete on tables to ee_app;
alter default privileges for role ee_owner in schema public
  grant usage, select on sequences to ee_app;

-- The app schema holds the RLS helper functions. They are SECURITY DEFINER and
-- run as ee_owner, which is what lets policies read org_member and lease_tenant
-- without recursing into their own policies.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'app') then
    grant usage on schema app to ee_app;
    grant execute on all functions in schema app to ee_app;
    alter default privileges for role ee_owner in schema app
      grant execute on functions to ee_app;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

\echo ''
\echo 'Roles (both must show f/f — no superuser, no RLS bypass):'
select rolname, rolsuper as superuser, rolbypassrls as bypasses_rls, rolcanlogin as can_login
  from pg_roles where rolname in ('ee_owner', 'ee_app') order by rolname;

\echo ''
\echo 'Database owner (must be ee_owner):'
select current_database() as database, pg_get_userbyid(datdba) as owner
  from pg_database where datname = current_database();

\echo ''
\echo 'ee_app must NOT be able to create objects in public (want f):'
select has_schema_privilege('ee_app', 'public', 'CREATE') as can_create_objects,
       has_schema_privilege('ee_app', 'public', 'USAGE')  as can_use_schema;
