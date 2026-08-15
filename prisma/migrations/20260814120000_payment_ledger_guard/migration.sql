-- Layer-2 only migration: partial unique indexes Prisma cannot express.
-- Source of truth: db/sql/0006_payment_ledger_guard.sql

-- 0006_payment_ledger_guard.sql
--
-- Exactly one credit per payment, enforced by the database.
--
-- Application code already checks before inserting, but two webhook deliveries
-- landing concurrently would both pass that check and both insert — the classic
-- read-then-write race. For a payment ledger the consequence is a tenant
-- credited twice for one ACH debit, which surfaces later as an unexplainable
-- balance. Partial, because a payment may also have a reversal entry.
create unique index ledger_one_payment_entry_per_payment
  on "ledger_entry" (payment_id)
  where entry_type = 'payment' and payment_id is not null;

-- Same reasoning for reversals: an entry may be reversed at most once. There is
-- already a unique index on reverses_entry_id, so this is belt and braces for
-- the payment-scoped case.
create unique index ledger_one_reversal_per_payment
  on "ledger_entry" (payment_id)
  where entry_type = 'reversal' and payment_id is not null;
