-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "org_role" AS ENUM ('owner', 'staff');

-- CreateEnum
CREATE TYPE "property_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "lease_status" AS ENUM ('draft', 'active', 'ended');

-- CreateEnum
CREATE TYPE "charge_type" AS ENUM ('rent', 'water', 'late_fee', 'deposit', 'other');

-- CreateEnum
CREATE TYPE "split_mode" AS ENUM ('percent', 'fixed');

-- CreateEnum
CREATE TYPE "split_status" AS ENUM ('proposed', 'active', 'rejected', 'superseded');

-- CreateEnum
CREATE TYPE "entry_type" AS ENUM ('charge', 'payment', 'credit', 'waiver', 'reversal');

-- CreateEnum
CREATE TYPE "payment_method_kind" AS ENUM ('us_bank_account', 'card');

-- CreateEnum
CREATE TYPE "payment_channel" AS ENUM ('ach', 'card', 'check', 'cash', 'other_manual');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "late_fee_kind" AS ENUM ('flat', 'percent_of_rent');

-- CreateEnum
CREATE TYPE "connect_status" AS ENUM ('not_started', 'pending', 'active', 'restricted');

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "request_ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "org_id" UUID,
    "lease_id" UUID,
    "org_role" "org_role",
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "stripe_connected_account_id" TEXT,
    "connect_status" "connect_status" NOT NULL DEFAULT 'not_started',
    "connect_payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_member" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "org_role" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "jurisdiction_id" TEXT NOT NULL DEFAULT 'us-pa-pittsburgh',
    "late_fee_kind" "late_fee_kind" NOT NULL DEFAULT 'percent_of_rent',
    "late_fee_value" BIGINT NOT NULL DEFAULT 5,
    "late_fee_grace_days" INTEGER NOT NULL DEFAULT 5,
    "late_fee_cap_cents" BIGINT,
    "late_fee_applies_to_water" BOOLEAN NOT NULL DEFAULT false,
    "status" "property_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "bedrooms" INTEGER,
    "square_feet" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lease" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "unit_id" UUID NOT NULL,
    "status" "lease_status" NOT NULL DEFAULT 'draft',
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "rent_due_day" INTEGER NOT NULL DEFAULT 1,
    "security_deposit_cents" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lease_rent_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "rent_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_rent_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lease_tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "moved_in_on" DATE,
    "moved_out_on" DATE,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lease_tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_plan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "charge_type" "charge_type" NOT NULL,
    "mode" "split_mode" NOT NULL,
    "status" "split_status" NOT NULL DEFAULT 'proposed',
    "effective_from" DATE NOT NULL,
    "proposed_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "split_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_share" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "split_plan_id" UUID NOT NULL,
    "lease_tenant_id" UUID NOT NULL,
    "percent_bps" INTEGER,
    "fixed_cents" BIGINT,
    "absorbs_remainder" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "split_share_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "charge_type" "charge_type" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "description" TEXT,
    "period_start" DATE,
    "period_end" DATE,
    "due_on" DATE NOT NULL,
    "document_url" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_allocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "charge_id" UUID NOT NULL,
    "lease_tenant_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "split_plan_id" UUID,

    CONSTRAINT "charge_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_customer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_method" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "stripe_payment_method_id" TEXT NOT NULL,
    "kind" "payment_method_kind" NOT NULL,
    "last4" TEXT,
    "bank_name" TEXT,
    "mandate_reference" TEXT,
    "mandate_accepted_at" TIMESTAMPTZ(6),
    "mandate_accepted_ip" INET,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "detached_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "payer_user_id" UUID,
    "amount_cents" BIGINT NOT NULL,
    "channel" "payment_channel" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "payment_method_id" UUID,
    "stripe_payment_intent_id" TEXT,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "initiated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),
    "reversed_at" TIMESTAMPTZ(6),
    "idempotency_key" TEXT NOT NULL,
    "recorded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_event" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "connected_account_id" TEXT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "process_error" TEXT,

    CONSTRAINT "stripe_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autopay_enrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_tenant_id" UUID NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "day_of_month" INTEGER NOT NULL,
    "use_fixed_amount" BOOLEAN NOT NULL DEFAULT false,
    "fixed_cents" BIGINT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autopay_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "entry_type" "entry_type" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "charge_id" UUID,
    "payment_id" UUID,
    "reverses_entry_id" UUID,
    "lease_tenant_id" UUID,
    "memo" TEXT,
    "effective_on" DATE NOT NULL DEFAULT current_date,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_deposit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lease_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "received_on" DATE,
    "escrow_institution_name" TEXT,
    "escrow_institution_address" TEXT,
    "tenant_notified_on" DATE,
    "interest_bearing" BOOLEAN NOT NULL DEFAULT false,
    "interest_bearing_since" DATE,
    "return_due_on" DATE,
    "returned_on" DATE,
    "returned_cents" BIGINT,
    "itemization" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "sent_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "org_stripe_connected_account_id_key" ON "org"("stripe_connected_account_id");

-- CreateIndex
CREATE INDEX "org_member_user_id_idx" ON "org_member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_member_org_id_user_id_key" ON "org_member"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "property_org_id_idx" ON "property"("org_id");

-- CreateIndex
CREATE INDEX "unit_property_id_idx" ON "unit"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_property_id_label_key" ON "unit"("property_id", "label");

-- CreateIndex
CREATE INDEX "lease_unit_id_idx" ON "lease"("unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "lease_rent_period_lease_id_effective_from_key" ON "lease_rent_period"("lease_id", "effective_from");

-- CreateIndex
CREATE INDEX "lease_tenant_user_id_idx" ON "lease_tenant"("user_id");

-- CreateIndex
CREATE INDEX "lease_tenant_lease_id_idx" ON "lease_tenant"("lease_id");

-- CreateIndex
CREATE UNIQUE INDEX "lease_tenant_lease_id_user_id_key" ON "lease_tenant"("lease_id", "user_id");

-- CreateIndex
CREATE INDEX "split_plan_lease_id_idx" ON "split_plan"("lease_id");

-- CreateIndex
CREATE UNIQUE INDEX "split_share_split_plan_id_lease_tenant_id_key" ON "split_share"("split_plan_id", "lease_tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "charge_idempotency_key_key" ON "charge"("idempotency_key");

-- CreateIndex
CREATE INDEX "charge_lease_id_due_on_idx" ON "charge"("lease_id", "due_on");

-- CreateIndex
CREATE INDEX "charge_due_on_charge_type_idx" ON "charge"("due_on", "charge_type");

-- CreateIndex
CREATE INDEX "charge_allocation_lease_tenant_id_idx" ON "charge_allocation"("lease_tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "charge_allocation_charge_id_lease_tenant_id_key" ON "charge_allocation"("charge_id", "lease_tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_customer_user_id_key" ON "stripe_customer"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_customer_stripe_customer_id_key" ON "stripe_customer"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_method_stripe_payment_method_id_key" ON "payment_method"("stripe_payment_method_id");

-- CreateIndex
CREATE INDEX "payment_method_user_id_idx" ON "payment_method"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_stripe_payment_intent_id_key" ON "payment"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotency_key_key" ON "payment"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_lease_id_initiated_at_idx" ON "payment"("lease_id", "initiated_at" DESC);

-- CreateIndex
CREATE INDEX "payment_payer_user_id_idx" ON "payment"("payer_user_id");

-- CreateIndex
CREATE INDEX "payment_status_idx" ON "payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "autopay_enrollment_lease_tenant_id_key" ON "autopay_enrollment"("lease_tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_reverses_entry_id_key" ON "ledger_entry"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "ledger_entry_lease_id_effective_on_created_at_idx" ON "ledger_entry"("lease_id", "effective_on", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entry_charge_id_idx" ON "ledger_entry"("charge_id");

-- CreateIndex
CREATE INDEX "ledger_entry_payment_id_idx" ON "ledger_entry"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "security_deposit_lease_id_key" ON "security_deposit"("lease_id");

-- CreateIndex
CREATE INDEX "security_deposit_return_due_on_idx" ON "security_deposit"("return_due_on");

-- CreateIndex
CREATE UNIQUE INDEX "notification_log_dedupe_key_key" ON "notification_log"("dedupe_key");

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member" ADD CONSTRAINT "org_member_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member" ADD CONSTRAINT "org_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property" ADD CONSTRAINT "property_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit" ADD CONSTRAINT "unit_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lease" ADD CONSTRAINT "lease_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lease_rent_period" ADD CONSTRAINT "lease_rent_period_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lease_tenant" ADD CONSTRAINT "lease_tenant_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lease_tenant" ADD CONSTRAINT "lease_tenant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_plan" ADD CONSTRAINT "split_plan_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_plan" ADD CONSTRAINT "split_plan_proposed_by_fkey" FOREIGN KEY ("proposed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_plan" ADD CONSTRAINT "split_plan_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_share" ADD CONSTRAINT "split_share_split_plan_id_fkey" FOREIGN KEY ("split_plan_id") REFERENCES "split_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_share" ADD CONSTRAINT "split_share_lease_tenant_id_fkey" FOREIGN KEY ("lease_tenant_id") REFERENCES "lease_tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge" ADD CONSTRAINT "charge_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge" ADD CONSTRAINT "charge_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_allocation" ADD CONSTRAINT "charge_allocation_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_allocation" ADD CONSTRAINT "charge_allocation_lease_tenant_id_fkey" FOREIGN KEY ("lease_tenant_id") REFERENCES "lease_tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge_allocation" ADD CONSTRAINT "charge_allocation_split_plan_id_fkey" FOREIGN KEY ("split_plan_id") REFERENCES "split_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_customer" ADD CONSTRAINT "stripe_customer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_payer_user_id_fkey" FOREIGN KEY ("payer_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_method"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_enrollment" ADD CONSTRAINT "autopay_enrollment_lease_tenant_id_fkey" FOREIGN KEY ("lease_tenant_id") REFERENCES "lease_tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autopay_enrollment" ADD CONSTRAINT "autopay_enrollment_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_method"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_lease_tenant_id_fkey" FOREIGN KEY ("lease_tenant_id") REFERENCES "lease_tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "ledger_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_deposit" ADD CONSTRAINT "security_deposit_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- SAFETY LAYER — see db/sql/0001_safety_layer.sql (source of truth)
-- Constraints, triggers, partial indexes, view, and RLS that Prisma's schema
-- language cannot express. Regenerate this migration and you MUST re-append.
-- ===========================================================================

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
