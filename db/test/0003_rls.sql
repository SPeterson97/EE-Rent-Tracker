-- Asserts row level security actually isolates one landlord from another.
-- MUST be run as the NON-OWNER application role (ee_app). Running this as the
-- table owner will show everything visible to everyone, because owners bypass
-- RLS by default -- which is precisely the failure mode being guarded against.

\pset format aligned

create or replace function pg_temp.visible(who text)
returns table (
  actor       text,
  orgs        bigint,
  properties  bigint,
  leases      bigint,
  charges     bigint,
  ledger      bigint,
  pay_methods bigint,
  balances    bigint
) language sql stable as $$
  select who,
    (select count(*) from org),
    (select count(*) from property),
    (select count(*) from lease),
    (select count(*) from charge),
    (select count(*) from ledger_entry),
    (select count(*) from payment_method),
    (select count(*) from lease_balance);
$$;

\echo '=== Visibility by actor (each row is one logged-in user) ==='

select set_config('app.current_user_id', '', false);
select * from pg_temp.visible('(nobody logged in)');

select set_config('app.current_user_id', '11111111-1111-1111-1111-111111111111', false);
select * from pg_temp.visible('Alice  landlord org A');

select set_config('app.current_user_id', '22222222-2222-2222-2222-222222222222', false);
select * from pg_temp.visible('Bob    landlord org B');

select set_config('app.current_user_id', '33333333-3333-3333-3333-333333333333', false);
select * from pg_temp.visible('Tam    tenant on lease A');

select set_config('app.current_user_id', '55555555-5555-5555-5555-555555555555', false);
select * from pg_temp.visible('Quinn  tenant on lease B');

\echo ''
\echo '=== Cross-tenant leak checks (all must be 0) ==='

select set_config('app.current_user_id', '11111111-1111-1111-1111-111111111111', false);
select 'Alice sees Bob''s leases'        as check, count(*) as rows
  from lease where id = 'b0000000-0000-0000-0000-000000000003'
union all
select 'Alice sees Bob''s charges',      count(*)
  from charge where lease_id = 'b0000000-0000-0000-0000-000000000003'
union all
select 'Alice sees Bob''s ledger',       count(*)
  from ledger_entry where lease_id = 'b0000000-0000-0000-0000-000000000003'
union all
select 'Alice sees tenant Tam''s bank',  count(*)
  from payment_method where user_id = '33333333-3333-3333-3333-333333333333';

select set_config('app.current_user_id', '33333333-3333-3333-3333-333333333333', false);
select 'Tam sees her own bank (want 1)'  as check, count(*) as rows
  from payment_method
union all
select 'Tam sees co-tenant Rae on lease', count(*)
  from lease_tenant where user_id = '44444444-4444-4444-4444-444444444444'
union all
select 'Tam sees Quinn on lease B',       count(*)
  from lease_tenant where user_id = '55555555-5555-5555-5555-555555555555';

\echo ''
\echo '=== lease_balance view honours RLS (security_invoker) ==='
select set_config('app.current_user_id', '11111111-1111-1111-1111-111111111111', false);
select 'Alice' as actor, lease_id, balance_cents from lease_balance;
select set_config('app.current_user_id', '22222222-2222-2222-2222-222222222222', false);
select 'Bob'   as actor, lease_id, balance_cents from lease_balance;
