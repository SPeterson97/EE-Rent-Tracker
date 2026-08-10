-- Asserts that the safety layer REJECTS what it is supposed to reject.
-- Run as the owner role. Everything happens inside a transaction that is
-- rolled back, so the seed data is left untouched.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

-- Harness: runs a statement in a subtransaction and reports whether the
-- database rejected it. A statement that succeeds when it should have failed
-- is the interesting failure mode, so that is reported loudly.
create or replace function pg_temp.expect_reject(label text, stmt text) returns text
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    return format('  PASS   %s', label);
  end;
  return format('  FAIL   %s  <-- ACCEPTED, should have been REJECTED', label);
end $$;

select '--- append-only ledger ---';

select pg_temp.expect_reject('UPDATE on ledger_entry',
  $$update ledger_entry set amount_cents = 1 where id = 'a0000000-0000-0000-0000-000000000008'$$);

select pg_temp.expect_reject('DELETE on ledger_entry',
  $$delete from ledger_entry where id = 'a0000000-0000-0000-0000-000000000008'$$);

select '--- ledger sign conventions ---';

select pg_temp.expect_reject('charge entry with negative amount',
  $$insert into ledger_entry (lease_id, entry_type, amount_cents)
    values ('a0000000-0000-0000-0000-000000000003', 'charge', -500)$$);

select pg_temp.expect_reject('payment entry with positive amount',
  $$insert into ledger_entry (lease_id, entry_type, amount_cents)
    values ('a0000000-0000-0000-0000-000000000003', 'payment', 500)$$);

select pg_temp.expect_reject('zero-amount ledger entry',
  $$insert into ledger_entry (lease_id, entry_type, amount_cents)
    values ('a0000000-0000-0000-0000-000000000003', 'credit', 0)$$);

select pg_temp.expect_reject('reversal with no target entry',
  $$insert into ledger_entry (lease_id, entry_type, amount_cents)
    values ('a0000000-0000-0000-0000-000000000003', 'reversal', -100)$$);

select pg_temp.expect_reject('second reversal of the same entry',
  $$insert into ledger_entry (lease_id, entry_type, amount_cents, reverses_entry_id)
    select 'a0000000-0000-0000-0000-000000000003', 'reversal', -100,
           'a0000000-0000-0000-0000-000000000009'
    from generate_series(1,2)$$);

select '--- charge and lease constraints ---';

select pg_temp.expect_reject('zero-amount charge',
  $$insert into charge (lease_id, charge_type, amount_cents, due_on, idempotency_key)
    values ('a0000000-0000-0000-0000-000000000003', 'rent', 0, date '2026-10-01', 'zero:test')$$);

select pg_temp.expect_reject('duplicate charge idempotency_key (double-fired cron)',
  $$insert into charge (lease_id, charge_type, amount_cents, due_on, idempotency_key)
    values ('a0000000-0000-0000-0000-000000000003', 'rent', 210000, date '2026-09-01',
            'rent:a0000000-0000-0000-0000-000000000003:2026-09')$$);

select pg_temp.expect_reject('charge period_end before period_start',
  $$insert into charge (lease_id, charge_type, amount_cents, due_on, idempotency_key,
                        period_start, period_end)
    values ('a0000000-0000-0000-0000-000000000003', 'water', 5000, date '2026-10-01',
            'water:bad-period', date '2026-09-30', date '2026-09-01')$$);

select pg_temp.expect_reject('rent_due_day of 31 (unsafe in February)',
  $$insert into lease (unit_id, starts_on, rent_due_day)
    values ('a0000000-0000-0000-0000-000000000002', date '2026-01-01', 31)$$);

select pg_temp.expect_reject('lease ending before it starts',
  $$insert into lease (unit_id, starts_on, ends_on)
    values ('a0000000-0000-0000-0000-000000000002', date '2026-06-01', date '2026-01-01')$$);

select '--- split plan integrity ---';

select pg_temp.expect_reject('second ACTIVE rent split plan on one lease',
  $$insert into split_plan (lease_id, charge_type, mode, status, effective_from,
                            approved_by, approved_at)
    values ('a0000000-0000-0000-0000-000000000003', 'rent', 'percent', 'active',
            date '2026-10-01', '11111111-1111-1111-1111-111111111111', now())$$);

select pg_temp.expect_reject('ACTIVE split plan with no approver',
  $$insert into split_plan (lease_id, charge_type, mode, status, effective_from)
    values ('a0000000-0000-0000-0000-000000000003', 'water', 'percent', 'active',
            date '2026-10-01')$$);

select pg_temp.expect_reject('share with both percent AND fixed basis',
  $$insert into split_share (split_plan_id, lease_tenant_id, percent_bps, fixed_cents)
    values ('a0000000-0000-0000-0000-000000000006',
            'a0000000-0000-0000-0000-000000000004', 5000, 5000)$$);

select pg_temp.expect_reject('percent share above 100%',
  $$insert into split_share (split_plan_id, lease_tenant_id, percent_bps)
    values ('a0000000-0000-0000-0000-000000000006',
            'a0000000-0000-0000-0000-000000000005', 10001)$$);

select '--- auth and payment uniqueness ---';

select pg_temp.expect_reject('two live login codes for one email',
  $$insert into auth_code (email, code_hash, expires_at)
    select 'tam@tenant.test', 'hash' || g, now() + interval '10 min'
    from generate_series(1,2) g$$);

select pg_temp.expect_reject('second default payment method for one user',
  $$insert into payment_method (user_id, stripe_payment_method_id, kind, is_default)
    values ('33333333-3333-3333-3333-333333333333', 'pm_test_tam_2',
            'us_bank_account', true)$$);

select pg_temp.expect_reject('autopay on day 31',
  $$insert into autopay_enrollment (lease_tenant_id, payment_method_id, day_of_month)
    values ('a0000000-0000-0000-0000-000000000004',
            'a0000000-0000-0000-0000-00000000000a', 31)$$);

select pg_temp.expect_reject('autopay set to fixed amount with no amount given',
  $$insert into autopay_enrollment (lease_tenant_id, payment_method_id, day_of_month,
                                    use_fixed_amount)
    values ('a0000000-0000-0000-0000-000000000004',
            'a0000000-0000-0000-0000-00000000000a', 1, true)$$);

select '--- invitation scoping ---';

select pg_temp.expect_reject('invitation targeting both an org and a lease',
  $$insert into invitation (email, token_hash, invited_by, org_id, lease_id, org_role, expires_at)
    values ('x@test.test', 'tok1', '11111111-1111-1111-1111-111111111111',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-000000000003',
            'staff', now() + interval '7 days')$$);

select pg_temp.expect_reject('invitation targeting neither org nor lease',
  $$insert into invitation (email, token_hash, invited_by, expires_at)
    values ('y@test.test', 'tok2', '11111111-1111-1111-1111-111111111111',
            now() + interval '7 days')$$);

rollback;

-- The deferred split-sum trigger fires at COMMIT, so it needs its own
-- transaction. SET CONSTRAINTS ALL IMMEDIATE forces the queued check to run
-- while we can still observe it.
begin;
  insert into split_plan (id, lease_id, charge_type, mode, status, effective_from)
    values ('c0000000-0000-0000-0000-0000000000ff', 'a0000000-0000-0000-0000-000000000003',
            'water', 'percent', 'proposed', date '2026-10-01');
  insert into split_share (split_plan_id, lease_tenant_id, percent_bps) values
    ('c0000000-0000-0000-0000-0000000000ff', 'a0000000-0000-0000-0000-000000000004', 6000),
    ('c0000000-0000-0000-0000-0000000000ff', 'a0000000-0000-0000-0000-000000000005', 3000);
  -- Totals 9000 bps, not 10000.
  select '--- deferred split-sum trigger (expect an error immediately below) ---';
  set constraints all immediate;
rollback;
