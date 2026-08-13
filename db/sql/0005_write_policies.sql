-- 0005_write_policies.sql
--
-- Until now only SELECT policies existed, so ee_app could read but never write.
-- That was safe but unshippable.
--
-- Deliberately per-command (FOR INSERT / FOR UPDATE / FOR DELETE) rather than
-- FOR ALL: a FOR ALL policy would also widen SELECT, and the read rules here
-- are not the same as the write rules. Tenants can read their lease but must
-- not edit it.
--
-- Charge generation is NOT covered by these. It runs as a job through the owner
-- role, which is RLS-exempt by design — these policies exist for user-initiated
-- writes arriving over HTTP.

-- Leases the current user manages as a landlord, as opposed to occupies as a
-- tenant. SECURITY DEFINER to avoid recursing into the policies being defined.
create or replace function app.managed_lease_ids() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select l.id
    from "lease" l
    join "unit" u     on u.id = l.unit_id
    join "property" p on p.id = u.property_id
   where p.org_id in (select org_id from "org_member" where user_id = app.current_user_id());
$$;

create or replace function app.managed_property_ids() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select p.id from "property" p
   where p.org_id in (select org_id from "org_member" where user_id = app.current_user_id());
$$;

-- ---------------------------------------------------------------------------
-- Portfolio structure — landlords only
-- ---------------------------------------------------------------------------

create policy property_insert on "property" for insert
  with check (org_id in (select app.user_org_ids()));
create policy property_update on "property" for update
  using (org_id in (select app.user_org_ids()))
  with check (org_id in (select app.user_org_ids()));

create policy unit_insert on "unit" for insert
  with check (property_id in (select app.managed_property_ids()));
create policy unit_update on "unit" for update
  using (property_id in (select app.managed_property_ids()))
  with check (property_id in (select app.managed_property_ids()));

create policy lease_insert on "lease" for insert
  with check (unit_id in (select id from "unit" where property_id in (select app.managed_property_ids())));
create policy lease_update on "lease" for update
  using (id in (select app.managed_lease_ids()))
  with check (id in (select app.managed_lease_ids()));

create policy lease_rent_period_insert on "lease_rent_period" for insert
  with check (lease_id in (select app.managed_lease_ids()));

create policy lease_tenant_insert on "lease_tenant" for insert
  with check (lease_id in (select app.managed_lease_ids()));
create policy lease_tenant_update on "lease_tenant" for update
  using (lease_id in (select app.managed_lease_ids()))
  with check (lease_id in (select app.managed_lease_ids()));

-- ---------------------------------------------------------------------------
-- Charges and the ledger
--
-- No UPDATE or DELETE policy on charge: a posted charge is corrected with an
-- offsetting ledger entry, not by editing history. ledger_entry gets INSERT
-- only, and the append-only trigger blocks the rest regardless.
-- ---------------------------------------------------------------------------

create policy charge_insert on "charge" for insert
  with check (lease_id in (select app.managed_lease_ids()));

create policy charge_allocation_insert on "charge_allocation" for insert
  with check (charge_id in (select id from "charge" where lease_id in (select app.managed_lease_ids())));

create policy ledger_entry_insert on "ledger_entry" for insert
  with check (lease_id in (select app.managed_lease_ids()));

create policy security_deposit_insert on "security_deposit" for insert
  with check (lease_id in (select app.managed_lease_ids()));
create policy security_deposit_update on "security_deposit" for update
  using (lease_id in (select app.managed_lease_ids()))
  with check (lease_id in (select app.managed_lease_ids()));

-- ---------------------------------------------------------------------------
-- Split plans — the one place tenants write shared data
--
-- Tenants may PROPOSE a split for a lease they occupy. They may not approve
-- one: the with-check on insert pins status to 'proposed', and only the
-- landlord's policy can move a row to 'active'. That is the whole
-- propose/approve workflow, enforced in the database rather than in a handler.
-- ---------------------------------------------------------------------------

create policy split_plan_insert_tenant on "split_plan" for insert
  with check (
    lease_id in (select app.user_lease_ids())
    and status = 'proposed'
    and proposed_by = app.current_user_id()
  );

create policy split_plan_insert_landlord on "split_plan" for insert
  with check (lease_id in (select app.managed_lease_ids()));

-- A tenant may revise their own proposal only while it is still pending.
create policy split_plan_update_tenant on "split_plan" for update
  using (
    lease_id in (select app.user_lease_ids())
    and status = 'proposed'
    and proposed_by = app.current_user_id()
  )
  with check (status = 'proposed');

create policy split_plan_update_landlord on "split_plan" for update
  using (lease_id in (select app.managed_lease_ids()))
  with check (lease_id in (select app.managed_lease_ids()));

create policy split_plan_delete_tenant on "split_plan" for delete
  using (
    lease_id in (select app.user_lease_ids())
    and status = 'proposed'
    and proposed_by = app.current_user_id()
  );

create policy split_share_insert on "split_share" for insert
  with check (split_plan_id in (
    select id from "split_plan"
     where lease_id in (select app.user_lease_ids())
        or lease_id in (select app.managed_lease_ids())));

create policy split_share_update on "split_share" for update
  using (split_plan_id in (
    select id from "split_plan"
     where lease_id in (select app.user_lease_ids())
        or lease_id in (select app.managed_lease_ids())))
  with check (split_plan_id in (
    select id from "split_plan"
     where lease_id in (select app.user_lease_ids())
        or lease_id in (select app.managed_lease_ids())));

create policy split_share_delete on "split_share" for delete
  using (split_plan_id in (
    select id from "split_plan"
     where lease_id in (select app.user_lease_ids())
        or lease_id in (select app.managed_lease_ids())));

-- ---------------------------------------------------------------------------
-- Payments and instruments
--
-- A tenant may record a payment only against a lease they occupy AND only as
-- themselves — without the payer_user_id check a tenant could attribute their
-- roommate's payment to themselves.
-- ---------------------------------------------------------------------------

create policy payment_insert_tenant on "payment" for insert
  with check (
    lease_id in (select app.user_lease_ids())
    and payer_user_id = app.current_user_id()
  );

create policy payment_insert_landlord on "payment" for insert
  with check (lease_id in (select app.managed_lease_ids()));

-- Status transitions come from Stripe webhooks, which run as the owner role.
create policy payment_update_landlord on "payment" for update
  using (lease_id in (select app.managed_lease_ids()))
  with check (lease_id in (select app.managed_lease_ids()));

create policy payment_method_insert on "payment_method" for insert
  with check (user_id = app.current_user_id());
create policy payment_method_update on "payment_method" for update
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
create policy payment_method_delete on "payment_method" for delete
  using (user_id = app.current_user_id());

create policy autopay_insert on "autopay_enrollment" for insert
  with check (lease_tenant_id in (
    select id from "lease_tenant" where user_id = app.current_user_id()));
create policy autopay_update on "autopay_enrollment" for update
  using (lease_tenant_id in (
    select id from "lease_tenant" where user_id = app.current_user_id()))
  with check (lease_tenant_id in (
    select id from "lease_tenant" where user_id = app.current_user_id()));
create policy autopay_delete on "autopay_enrollment" for delete
  using (lease_tenant_id in (
    select id from "lease_tenant" where user_id = app.current_user_id()));
