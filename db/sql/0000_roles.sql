-- 0000_roles.sql — one-time bootstrap, run BEFORE the first migration.
--
-- Postgres roles are cluster-wide, not per-database, so this cannot live in a
-- Prisma migration: migrations run inside a database and are replayed per
-- environment, whereas roles are created once per server.
--
-- Two roles, and the split is the entire basis of tenant isolation:
--
--   <owner_role>  owns the tables. Runs migrations and trusted server jobs.
--                 BYPASSES RLS, because Postgres exempts table owners.
--   ee_app        owns nothing. This is what the running application connects
--                 as, and the only role RLS policies actually constrain.
--
-- Local Postgres — creates both roles:
--
--   psql -d ee_rent_tracker \
--     -v owner_password="$EE_OWNER_PASSWORD" \
--     -v app_password="$EE_APP_PASSWORD" \
--     -v ON_ERROR_STOP=1 \
--     -f db/sql/0000_roles.sql
--
-- Neon / RDS / managed — reuse the provider's existing owner role and create
-- only ee_app. Nothing needs to be created or renamed provider-side:
--
--   psql -d ee_rent_tracker \
--     -v owner_role=neondb_owner \
--     -v app_password="$EE_APP_PASSWORD" \
--     -v ON_ERROR_STOP=1 \
--     -f db/sql/0000_roles.sql
--
-- Safe to re-run: existing roles are left alone. See "Rotating a password" in
-- MIGRATIONS.md to change one deliberately.

\set ON_ERROR_STOP on

-- Defaults, so the managed-provider invocation can omit owner_password.
\if :{?owner_role}
\else
  \set owner_role ee_owner
\endif

\if :{?owner_password}
\else
  \set owner_password ''
\endif

\if :{?app_password}
\else
  \echo 'ERROR: -v app_password=... is required'
  \quit 1
\endif

\echo ''
\echo 'Bootstrapping roles. Owner role:'
select :'owner_role' as owner_role, current_database() as database;

-- ---------------------------------------------------------------------------
-- Roles
--
-- \gexec runs the generated statement. psql does not interpolate variables
-- inside dollar-quoted blocks, so a plain DO block cannot be used here.
-- ---------------------------------------------------------------------------

-- Skipped when the owner role already exists, which is the managed-provider
-- case: Neon's neondb_owner is created for you.
select format('create role %I login password %L', :'owner_role', :'owner_password')
 where not exists (select 1 from pg_roles where rolname = :'owner_role')
\gexec

select format('create role ee_app login password %L', :'app_password')
 where not exists (select 1 from pg_roles where rolname = 'ee_app')
\gexec

-- Neither role should be a superuser or hold BYPASSRLS. Setting these requires
-- superuser, which managed providers do not grant, so a failure here is
-- tolerated with a warning rather than aborting the bootstrap.
select set_config('bootstrap.owner_role', :'owner_role', false);

do $$
declare
  v_owner text := current_setting('bootstrap.owner_role');
begin
  begin
    execute format('alter role %I nosuperuser nocreaterole nobypassrls', v_owner);
    execute 'alter role ee_app nosuperuser nocreatedb nocreaterole nobypassrls';
  exception when insufficient_privilege or wrong_object_type then
    raise notice 'Could not set role attributes (needs superuser). Expected on managed Postgres — the verification query at the end of this script confirms what matters.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Database ownership
--
-- On managed providers the default role already owns the database and this is
-- a no-op. If it fails there, nothing is wrong — but DO check the verification
-- output, because the app role must not end up owning tables.
-- ---------------------------------------------------------------------------

do $$
declare
  v_owner text := current_setting('bootstrap.owner_role');
begin
  begin
    execute format('alter database %I owner to %I', current_database(), v_owner);
  exception when insufficient_privilege then
    raise notice 'Could not reassign database ownership; leaving as-is.';
  end;
end $$;

select format('grant connect on database %I to ee_app', current_database())
\gexec

-- ---------------------------------------------------------------------------
-- Schema privileges
--
-- ee_app may read and write rows but must never create, alter, or drop
-- objects — schema changes belong to migrations running as the owner role.
-- ---------------------------------------------------------------------------

revoke create on schema public from public;
revoke create on schema public from ee_app;

grant usage on schema public to ee_app;

-- Existing objects. Tables created by later migrations are covered by the
-- default privileges below.
grant select, insert, update, delete on all tables    in schema public to ee_app;
grant usage, select                  on all sequences in schema public to ee_app;

-- CRITICAL: default privileges apply only to objects subsequently created BY
-- the named role. This is why migrations must always run as the owner role —
-- a migration applied as anyone else produces tables ee_app cannot read, and
-- the resulting permission errors look unrelated to the cause.
do $$
declare
  v_owner text := current_setting('bootstrap.owner_role');
begin
  execute format(
    'alter default privileges for role %I in schema public
       grant select, insert, update, delete on tables to ee_app', v_owner);
  execute format(
    'alter default privileges for role %I in schema public
       grant usage, select on sequences to ee_app', v_owner);

  -- The app schema holds the RLS helper functions. They are SECURITY DEFINER
  -- and run as the owner, which is what lets policies read org_member and
  -- lease_tenant without recursing into their own policies.
  if exists (select 1 from pg_namespace where nspname = 'app') then
    grant usage on schema app to ee_app;
    grant execute on all functions in schema app to ee_app;
    execute format(
      'alter default privileges for role %I in schema app
         grant execute on functions to ee_app', v_owner);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verification — these are the assertions that actually matter
-- ---------------------------------------------------------------------------

\echo ''
\echo 'Roles (bypasses_rls MUST be f for both):'
select rolname, rolsuper as superuser, rolbypassrls as bypasses_rls, rolcanlogin as can_login
  from pg_roles
 where rolname in (:'owner_role', 'ee_app')
 order by rolname;

\echo ''
\echo 'Database owner (must NOT be ee_app):'
select current_database() as database, pg_get_userbyid(datdba) as owner
  from pg_database where datname = current_database();

\echo ''
\echo 'ee_app must not be able to create objects (want f / t):'
select has_schema_privilege('ee_app', 'public', 'CREATE') as can_create_objects,
       has_schema_privilege('ee_app', 'public', 'USAGE')  as can_use_schema;

\echo ''
\echo 'Tables owned by ee_app (MUST be empty — ownership defeats RLS):'
select tablename from pg_tables
 where schemaname = 'public' and tableowner = 'ee_app';
