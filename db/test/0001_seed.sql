-- Deterministic seed for schema behaviour tests. Run as the OWNER role, which
-- bypasses RLS so two isolated orgs can be created in one pass.
--
-- Org A: landlord Alice, unit with two tenants (Tam and Rae) splitting 60/40.
-- Org B: landlord Bob, entirely separate. RLS tests assert A and B cannot see
-- each other.

begin;

insert into app_user (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@landlord.test', 'Alice Landlord'),
  ('22222222-2222-2222-2222-222222222222', 'bob@landlord.test',   'Bob Landlord'),
  ('33333333-3333-3333-3333-333333333333', 'tam@tenant.test',     'Tam Tenant'),
  ('44444444-4444-4444-4444-444444444444', 'rae@tenant.test',     'Rae Tenant'),
  ('55555555-5555-5555-5555-555555555555', 'quinn@tenant.test',   'Quinn Tenant');

insert into org (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alice Properties LLC'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Bob Holdings LLC');

insert into org_member (org_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner');

insert into property (id, org_id, name, line1, city, region, postal_code, timezone, jurisdiction_id) values
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'Liberty Ave Duplex', '4200 Liberty Ave', 'Pittsburgh', 'PA', '15224',
   'America/New_York', 'us-pa-pittsburgh'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'Bob Fourplex', '99 Elsewhere St', 'Cleveland', 'OH', '44101',
   'America/New_York', 'us-oh');

insert into unit (id, property_id, label, bedrooms, square_feet) values
  ('a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '3B', 2, 900),
  ('b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', '1A', 1, 600);

insert into lease (id, unit_id, status, starts_on, rent_due_day, security_deposit_cents) values
  ('a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002',
   'active', date '2026-01-01', 1, 240000),
  ('b0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002',
   'active', date '2026-03-01', 1, 90000);

insert into lease_rent_period (lease_id, effective_from, rent_cents) values
  ('a0000000-0000-0000-0000-000000000003', date '2026-01-01', 210000),
  ('b0000000-0000-0000-0000-000000000003', date '2026-03-01', 95000);

insert into lease_tenant (id, lease_id, user_id, moved_in_on, is_primary) values
  ('a0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003',
   '33333333-3333-3333-3333-333333333333', date '2026-01-01', true),
  ('a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000003',
   '44444444-4444-4444-4444-444444444444', date '2026-01-01', false),
  ('b0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000003',
   '55555555-5555-5555-5555-555555555555', date '2026-03-01', true);

-- Approved 60/40 rent split. Tam absorbs rounding remainder.
insert into split_plan (id, lease_id, charge_type, mode, status, effective_from,
                        proposed_by, approved_by, approved_at) values
  ('a0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000003',
   'rent', 'percent', 'active', date '2026-01-01',
   '33333333-3333-3333-3333-333333333333',
   '11111111-1111-1111-1111-111111111111', now());

insert into split_share (split_plan_id, lease_tenant_id, percent_bps, absorbs_remainder) values
  ('a0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000004', 6000, true),
  ('a0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000005', 4000, false);

-- One month of rent on each lease.
insert into charge (id, lease_id, charge_type, amount_cents, due_on, idempotency_key) values
  ('a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000003',
   'rent', 210000, date '2026-09-01', 'rent:a0000000-0000-0000-0000-000000000003:2026-09'),
  ('b0000000-0000-0000-0000-000000000007', 'b0000000-0000-0000-0000-000000000003',
   'rent',  95000, date '2026-09-01', 'rent:b0000000-0000-0000-0000-000000000003:2026-09');

insert into charge_allocation (charge_id, lease_tenant_id, amount_cents, split_plan_id) values
  ('a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000004', 126000,
   'a0000000-0000-0000-0000-000000000006'),
  ('a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000005',  84000,
   'a0000000-0000-0000-0000-000000000006');

insert into ledger_entry (id, lease_id, entry_type, amount_cents, charge_id, effective_on, memo) values
  ('a0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000003',
   'charge', 210000, 'a0000000-0000-0000-0000-000000000007', date '2026-09-01', 'September rent'),
  ('b0000000-0000-0000-0000-000000000008', 'b0000000-0000-0000-0000-000000000003',
   'charge',  95000, 'b0000000-0000-0000-0000-000000000007', date '2026-09-01', 'September rent');

-- Tam pays her share; Rae has not paid.
insert into ledger_entry (id, lease_id, entry_type, amount_cents, lease_tenant_id, effective_on, memo) values
  ('a0000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000003',
   'payment', -126000, 'a0000000-0000-0000-0000-000000000004', date '2026-09-02', 'Tam ACH');

insert into payment_method (id, user_id, stripe_payment_method_id, kind, last4, is_default) values
  ('a0000000-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333',
   'pm_test_tam', 'us_bank_account', '6789', true);

commit;
