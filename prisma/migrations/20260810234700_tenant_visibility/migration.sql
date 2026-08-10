-- Layer-2 only migration: RLS policies, which Prisma cannot express.
-- Source of truth: db/sql/0004_tenant_visibility.sql

-- 0004_tenant_visibility.sql
--
-- Fixes a real gap found by the HTTP suite: a tenant could read their own
-- lease, charges, and ledger, but NOT the unit or property the lease is on,
-- because unit_visible and property_visible were scoped to org membership and
-- tenants hold none.
--
-- The failure mode is worth remembering. Prisma types a required relation as
-- non-nullable, but RLS filters rows AFTER the join, so `lease.unit` came back
-- null on a field the type system swore could not be. Row level security can
-- make any required relation nullable at runtime — a missing policy surfaces as
-- a TypeError, not as a permission error.

create or replace function app.tenant_unit_ids() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select l.unit_id
    from "lease" l
   where l.id in (select lease_id from "lease_tenant" where user_id = app.current_user_id());
$$;

create or replace function app.tenant_property_ids() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select u.property_id
    from "unit" u
   where u.id in (select app.tenant_unit_ids());
$$;

-- Policies for the same command are OR'd together, so these widen access for
-- tenants without loosening anything for landlords.
create policy unit_visible_to_tenant on "unit"
  for select using (id in (select app.tenant_unit_ids()));

create policy property_visible_to_tenant on "property"
  for select using (id in (select app.tenant_property_ids()));
