-- 0007_allocation_sum.sql
--
-- Per-tenant allocations must sum to exactly their charge.
--
-- The application already guarantees this (allocate() floors shares and hands
-- every leftover cent to a designated absorber), but a rounding change, a
-- hand-written correction, or a future import path could break it silently.
-- The symptom would be tenants whose shares do not add up to the rent — the
-- kind of discrepancy nobody notices until someone disputes a balance.
--
-- Deferred, because allocations are inserted one row at a time and the sum is
-- only meaningful once the whole set is in.

create or replace function app.assert_allocations_balanced() returns trigger
  language plpgsql as $$
declare
  v_charge_id uuid;
  v_charge_amount bigint;
  v_allocated bigint;
begin
  if tg_op = 'DELETE' then
    v_charge_id := old.charge_id;
  else
    v_charge_id := new.charge_id;
  end if;

  select amount_cents into v_charge_amount from "charge" where id = v_charge_id;
  if v_charge_amount is null then
    return null;  -- charge removed in the same transaction
  end if;

  select coalesce(sum(amount_cents), 0) into v_allocated
    from "charge_allocation" where charge_id = v_charge_id;

  -- Zero allocations is legitimate: a charge on a lease with no tenants yet.
  if v_allocated <> 0 and v_allocated <> v_charge_amount then
    raise exception
      'charge % allocations total % but the charge is %',
      v_charge_id, v_allocated, v_charge_amount;
  end if;

  return null;
end;
$$;

create constraint trigger charge_allocation_balanced
  after insert or update or delete on "charge_allocation"
  deferrable initially deferred
  for each row execute function app.assert_allocations_balanced();
