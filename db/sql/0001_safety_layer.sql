-- 0001_safety_layer.sql
--
-- Everything Prisma's schema language cannot express. Prisma creates the
-- tables, enums, and ordinary indexes; this file adds the constraints,
-- triggers, partial indexes, view, and row level security that make the
-- schema actually safe.
--
-- This is appended verbatim to prisma/migrations/0001_init/migration.sql.
-- See MIGRATIONS.md — every future migration needs the same treatment.

-- ---------------------------------------------------------------------------
-- Session context helper
-- ---------------------------------------------------------------------------

create schema if not exists app;

-- Set per transaction by the application:
--   select set_config('app.current_user_id', $1, true)
-- Returns null when unset, which makes every RLS policy below fail closed.
create or replace function app.current_user_id() returns uuid
  language sql stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------

alter table "invitation"
  add constraint invitation_targets_exactly_one_scope
    check ((org_id is not null)::int + (lease_id is not null)::int = 1),
  add constraint invitation_org_invite_has_role
    check (org_id is null or org_role is not null);

alter table "property"
  add constraint property_late_fee_value_nonneg check (late_fee_value >= 0),
  add constraint property_grace_days_nonneg     check (late_fee_grace_days >= 0),
  add constraint property_late_fee_cap_nonneg
    check (late_fee_cap_cents is null or late_fee_cap_cents >= 0);

alter table "lease"
  add constraint lease_due_day_valid  check (rent_due_day between 1 and 28),
  add constraint lease_dates_ordered  check (ends_on is null or ends_on >= starts_on),
  add constraint lease_deposit_nonneg check (security_deposit_cents >= 0);

alter table "lease_rent_period"
  add constraint rent_cents_positive check (rent_cents >= 0);

alter table "lease_tenant"
  add constraint lease_tenant_dates_ordered
    check (moved_out_on is null or moved_in_on is null or moved_out_on >= moved_in_on);

-- Active and superseded plans were both approved at some point; proposed and
-- rejected ones never were.
alter table "split_plan"
  add constraint split_plan_approved_when_live
    check (status not in ('active', 'superseded')
           or (approved_by is not null and approved_at is not null));

alter table "split_share"
  add constraint split_share_exactly_one_basis
    check ((percent_bps is not null)::int + (fixed_cents is not null)::int = 1),
  add constraint split_share_percent_range
    check (percent_bps is null or percent_bps between 0 and 10000),
  add constraint split_share_fixed_nonneg
    check (fixed_cents is null or fixed_cents >= 0);

alter table "charge"
  add constraint charge_amount_positive check (amount_cents > 0),
  add constraint charge_period_ordered
    check (period_end is null or period_start is null or period_end >= period_start);

alter table "charge_allocation"
  add constraint allocation_nonneg check (amount_cents >= 0);

alter table "payment"
  add constraint payment_amount_positive check (amount_cents > 0);

alter table "autopay_enrollment"
  add constraint autopay_day_valid check (day_of_month between 1 and 28),
  add constraint autopay_fixed_amount_present
    check (not use_fixed_amount or fixed_cents is not null);

alter table "ledger_entry"
  add constraint ledger_amount_nonzero check (amount_cents <> 0),
  add constraint ledger_charge_is_positive
    check (entry_type <> 'charge' or amount_cents > 0),
  add constraint ledger_credits_are_negative
    check (entry_type not in ('payment', 'credit', 'waiver') or amount_cents < 0),
  add constraint ledger_reversal_points_at_entry
    check (entry_type <> 'reversal' or reverses_entry_id is not null);

alter table "security_deposit"
  add constraint deposit_amount_nonneg   check (amount_cents >= 0),
  add constraint deposit_returned_nonneg check (returned_cents is null or returned_cents >= 0);

-- ---------------------------------------------------------------------------
-- Partial indexes
--
-- The four unique ones are correctness, not performance: Prisma cannot express
-- an index WHERE clause, so without these a lease could have two active split
-- plans and a user two default payment methods.
-- ---------------------------------------------------------------------------

create unique index auth_code_one_live_per_email
  on "auth_code" (email) where consumed_at is null;

create unique index split_plan_one_active
  on "split_plan" (lease_id, charge_type) where status = 'active';

create unique index split_share_one_remainder_absorber
  on "split_share" (split_plan_id) where absorbs_remainder;

create unique index payment_method_one_default
  on "payment_method" (user_id) where is_default and detached_at is null;

-- Performance-only, all covering hot "pending work" queries.
create index auth_code_expiry on "auth_code" (expires_at) where consumed_at is null;
create index invitation_pending on "invitation" (email)
  where accepted_at is null and revoked_at is null;
create index lease_active on "lease" (status) where status = 'active';
create index payment_unsettled on "payment" (status)
  where status in ('pending', 'processing');
create index security_deposit_open_clock on "security_deposit" (return_due_on)
  where returned_on is null and return_due_on is not null;
create index notification_pending on "notification_log" (created_at) where sent_at is null;
create index stripe_event_unprocessed on "stripe_event" (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- Split plan integrity
--
-- Percent plans must total exactly 100%. Checked per-plan rather than per-row,
-- and deferred so an entire plan can be rewritten inside one transaction.
-- ---------------------------------------------------------------------------

create or replace function app.assert_split_plan_balanced() returns trigger
  language plpgsql as $$
declare
  v_plan_id uuid;
  v_mode    split_mode;
  v_total   int;
begin
  -- NEW is unassigned on DELETE and cannot be referenced unconditionally.
  if tg_op = 'DELETE' then
    v_plan_id := old.split_plan_id;
  else
    v_plan_id := new.split_plan_id;
  end if;

  select mode into v_mode from "split_plan" where id = v_plan_id;
  if v_mode is null then
    return null;  -- plan deleted in the same transaction
  end if;

  if v_mode = 'percent' then
    select coalesce(sum(percent_bps), 0) into v_total
      from "split_share" where split_plan_id = v_plan_id;
    if v_total <> 10000 then
      raise exception 'split plan % percent shares total % bps, must equal 10000',
        v_plan_id, v_total;
    end if;
  end if;

  return null;
end;
$$;

create constraint trigger split_share_balanced
  after insert or update or delete on "split_share"
  deferrable initially deferred
  for each row execute function app.assert_split_plan_balanced();

-- ---------------------------------------------------------------------------
-- Append-only ledger
--
-- A mistake or an ACH return posts an offsetting 'reversal' row. Nothing in
-- the ledger is ever edited or removed.
-- ---------------------------------------------------------------------------

create or replace function app.ledger_is_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception
    'ledger_entry is append-only; post an offsetting entry instead of %', tg_op;
end;
$$;

create trigger ledger_entry_no_mutation
  before update or delete on "ledger_entry"
  for each row execute function app.ledger_is_append_only();

-- security_invoker is mandatory: without it the view runs as its owner and
-- silently bypasses row level security on ledger_entry.
create or replace view lease_balance with (security_invoker = true) as
  select l.id as lease_id,
         coalesce(sum(e.amount_cents), 0)::bigint as balance_cents
    from "lease" l
    left join "ledger_entry" e on e.lease_id = l.id
   group by l.id;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Enforced in the database so a forgotten WHERE clause cannot leak one
-- landlord's data to another. These helpers are SECURITY DEFINER to avoid
-- infinite policy recursion: they run as the table owner, who bypasses RLS.
--
-- REQUIRED: the application must connect as a NON-OWNER role (ee_app). Table
-- owners bypass RLS by default, so connecting as ee_owner disables all of this.
-- ---------------------------------------------------------------------------

create or replace function app.user_org_ids() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select org_id from "org_member" where user_id = app.current_user_id();
$$;

create or replace function app.user_lease_ids() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select lease_id from "lease_tenant" where user_id = app.current_user_id();
$$;

-- Leases the current user may see: their own as a tenant, plus every lease
-- belonging to an org they are a member of.
create or replace function app.visible_lease_ids() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select lease_id from "lease_tenant" where user_id = app.current_user_id()
  union
  select l.id
    from "lease" l
    join "unit" u     on u.id = l.unit_id
    join "property" p on p.id = u.property_id
   where p.org_id in (select org_id from "org_member" where user_id = app.current_user_id());
$$;

alter table "org"                enable row level security;
alter table "org_member"         enable row level security;
alter table "property"           enable row level security;
alter table "unit"               enable row level security;
alter table "lease"              enable row level security;
alter table "lease_rent_period"  enable row level security;
alter table "lease_tenant"       enable row level security;
alter table "split_plan"         enable row level security;
alter table "split_share"        enable row level security;
alter table "charge"             enable row level security;
alter table "charge_allocation"  enable row level security;
alter table "payment"            enable row level security;
alter table "ledger_entry"       enable row level security;
alter table "security_deposit"   enable row level security;
alter table "payment_method"     enable row level security;
alter table "autopay_enrollment" enable row level security;

create policy org_visible on "org"
  for select using (id in (select app.user_org_ids()));

create policy org_member_visible on "org_member"
  for select using (org_id in (select app.user_org_ids()));

create policy property_visible on "property"
  for select using (org_id in (select app.user_org_ids()));

create policy unit_visible on "unit"
  for select using (property_id in (
    select id from "property" where org_id in (select app.user_org_ids())));

create policy lease_visible on "lease"
  for select using (id in (select app.visible_lease_ids()));

create policy lease_rent_period_visible on "lease_rent_period"
  for select using (lease_id in (select app.visible_lease_ids()));

create policy lease_tenant_visible on "lease_tenant"
  for select using (lease_id in (select app.visible_lease_ids()));

create policy split_plan_visible on "split_plan"
  for select using (lease_id in (select app.visible_lease_ids()));

create policy split_share_visible on "split_share"
  for select using (split_plan_id in (
    select id from "split_plan" where lease_id in (select app.visible_lease_ids())));

create policy charge_visible on "charge"
  for select using (lease_id in (select app.visible_lease_ids()));

create policy charge_allocation_visible on "charge_allocation"
  for select using (charge_id in (
    select id from "charge" where lease_id in (select app.visible_lease_ids())));

create policy payment_visible on "payment"
  for select using (lease_id in (select app.visible_lease_ids()));

create policy ledger_entry_visible on "ledger_entry"
  for select using (lease_id in (select app.visible_lease_ids()));

create policy security_deposit_visible on "security_deposit"
  for select using (lease_id in (select app.visible_lease_ids()));

-- Payment instruments are personal and never visible to the landlord.
create policy payment_method_own on "payment_method"
  for select using (user_id = app.current_user_id());

create policy autopay_own on "autopay_enrollment"
  for select using (lease_tenant_id in (
    select id from "lease_tenant" where user_id = app.current_user_id()));

-- ---------------------------------------------------------------------------
-- Application role grants
--
-- NOTE: only SELECT policies exist so far, so under RLS the app role currently
-- cannot INSERT, UPDATE, or DELETE on protected tables — writes fail closed.
-- Write policies get added alongside the endpoints that need them. Until then
-- mutations must go through a service path connecting as the owner role, which
-- does its own authorization. See MIGRATIONS.md.
-- ---------------------------------------------------------------------------

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ee_app') then
    grant usage on schema public, app to ee_app;
    grant select, insert, update, delete on all tables in schema public to ee_app;
    grant execute on all functions in schema app to ee_app;
    alter default privileges in schema public
      grant select, insert, update, delete on tables to ee_app;
  end if;
end $$;
