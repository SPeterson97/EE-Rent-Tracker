/**
 * What SHOULD be charged, decided without touching a database.
 *
 * Everything here is a pure function from a snapshot of lease state to a set of
 * intended charges. The job in run.ts loads the snapshot, calls these, and
 * writes the result — so the interesting logic is testable without a clock, a
 * transaction, or a cron trigger.
 */
import { allocate, applyCredits, lateFeeAmount, type ChargeKind, type LateFeeConfig } from "./allocate.js";
import {
  addDays,
  daysInMonth,
  dueDateFor,
  occupiedDays,
  overlapDays,
  periodEnd,
  periodKey,
  periodStart,
  type BillingPeriod,
} from "./period.js";

export interface TenantSnapshot {
  leaseTenantId: string;
  startsOn: Date;
  endsOn: Date | null;
  /** Basis points from the active split plan; null when no plan applies. */
  shareBps: number | null;
  absorbsRemainder: boolean;
}

export interface RentPeriodSnapshot {
  effectiveFrom: Date;
  rentCents: bigint;
}

export interface LeaseSnapshot {
  leaseId: string;
  status: "draft" | "active" | "ended";
  startsOn: Date;
  endsOn: Date | null;
  rentDueDay: number;
  timezone: string;
  rentPeriods: RentPeriodSnapshot[];
  tenants: TenantSnapshot[];
  lateFee: LateFeeConfig & { graceDays: number; appliesToWater: boolean };
}

export interface PlannedAllocation {
  leaseTenantId: string;
  amountCents: bigint;
}

export interface PlannedCharge {
  leaseId: string;
  kind: ChargeKind;
  amountCents: bigint;
  dueOn: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  description: string;
  idempotencyKey: string;
  allocations: PlannedAllocation[];
}

/** The rent in effect at a date: the latest period starting on or before it. */
export function rentInEffect(lease: LeaseSnapshot, on: Date): bigint | null {
  const applicable = lease.rentPeriods
    .filter((p) => p.effectiveFrom.getTime() <= on.getTime())
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  return applicable?.rentCents ?? null;
}

/** Tenants whose occupancy overlaps a window at all. */
function activeTenants(lease: LeaseSnapshot, from: Date, to: Date): TenantSnapshot[] {
  return lease.tenants.filter((t) => overlapDays(from, to, t) > 0);
}

/**
 * Allocation weights for a window.
 *
 * Combines the split plan with occupancy in one weight: a tenant who occupied
 * half the period at a 60% share carries weight 60 * days. That makes
 * mid-period move-ins fall out of the same arithmetic as the split itself,
 * instead of being a second correction pass.
 */
function weightsFor(tenants: TenantSnapshot[], from: Date, to: Date, prorate: boolean) {
  return tenants.map((t) => {
    const share = t.shareBps ?? Math.round(10000 / tenants.length);
    const days = prorate ? overlapDays(from, to, t) : 1;
    return { id: t.leaseTenantId, weight: share * days, absorbsRemainder: t.absorbsRemainder };
  });
}

/**
 * Rent for one period, or null when none is owed.
 *
 * Prorates when the lease starts or ends mid-month, which is the normal case
 * for a first and last month rather than an edge case.
 */
export function planRent(lease: LeaseSnapshot, period: BillingPeriod): PlannedCharge | null {
  if (lease.status !== "active") return null;

  const start = periodStart(period);
  const end = periodEnd(period);

  // Lease must overlap the month at all.
  if (lease.startsOn.getTime() > end.getTime()) return null;
  if (lease.endsOn && lease.endsOn.getTime() < start.getTime()) return null;

  const full = rentInEffect(lease, start) ?? rentInEffect(lease, lease.startsOn);
  if (full === null || full <= 0n) return null;

  const occupancy = occupiedDays(period, { startsOn: lease.startsOn, endsOn: lease.endsOn });
  if (occupancy.days <= 0) return null;

  const amountCents = occupancy.partial
    ? (full * BigInt(occupancy.days)) / BigInt(occupancy.total)
    : full;

  if (amountCents <= 0n) return null;

  const tenants = activeTenants(lease, start, end);
  const weights = weightsFor(tenants, start, end, occupancy.partial || tenants.some(
    (t) => overlapDays(start, end, t) < daysInMonth(period),
  ));

  return {
    leaseId: lease.leaseId,
    kind: "rent",
    amountCents,
    dueOn: dueDateFor(period, lease.rentDueDay),
    periodStart: start,
    periodEnd: end,
    description: occupancy.partial
      ? `Rent ${periodKey(period)} (prorated ${occupancy.days}/${occupancy.total} days)`
      : `Rent ${periodKey(period)}`,
    idempotencyKey: `rent:${lease.leaseId}:${periodKey(period)}`,
    allocations: allocate(amountCents, weights).map((a) => ({
      leaseTenantId: a.id,
      amountCents: a.amountCents,
    })),
  };
}

export interface WaterBillInput {
  amountCents: bigint;
  serviceStart: Date;
  serviceEnd: Date;
  dueOn: Date;
  /** Distinguishes bills when one service period is billed more than once. */
  reference?: string;
}

/**
 * A water charge for a service window that has already elapsed.
 *
 * Allocation is weighted by days of overlap, so a tenant who moved out halfway
 * through the billed period pays for half of it. The window comes from the
 * utility bill, never from when it happened to arrive.
 */
export function planWater(lease: LeaseSnapshot, bill: WaterBillInput): PlannedCharge | null {
  if (bill.amountCents <= 0n) return null;

  const tenants = activeTenants(lease, bill.serviceStart, bill.serviceEnd);
  if (tenants.length === 0) return null;

  const weights = weightsFor(tenants, bill.serviceStart, bill.serviceEnd, true);
  const window = `${bill.serviceStart.toISOString().slice(0, 10)}_${bill.serviceEnd
    .toISOString()
    .slice(0, 10)}`;

  return {
    leaseId: lease.leaseId,
    kind: "water",
    amountCents: bill.amountCents,
    dueOn: bill.dueOn,
    periodStart: bill.serviceStart,
    periodEnd: bill.serviceEnd,
    description: `Water ${window.replace("_", " to ")}`,
    idempotencyKey: `water:${lease.leaseId}:${window}${bill.reference ? `:${bill.reference}` : ""}`,
    allocations: allocate(bill.amountCents, weights).map((a) => ({
      leaseTenantId: a.id,
      amountCents: a.amountCents,
    })),
  };
}

export interface PostedCharge {
  id: string;
  kind: ChargeKind;
  amountCents: bigint;
  dueOn: Date;
}

/**
 * Whether a late fee is owed for a period, given everything already posted and
 * the total credited to the lease.
 *
 * Deliberately takes `asOfLocalDate` — the calendar date in the property's
 * timezone — rather than reading a clock. That is what makes the grace period
 * testable and correct across DST.
 */
export function planLateFee(
  lease: LeaseSnapshot,
  period: BillingPeriod,
  posted: PostedCharge[],
  totalCreditsCents: bigint,
  asOfLocalDate: Date,
): PlannedCharge | null {
  // Uniqueness of this key is enforced by a database constraint, so a second
  // run — or two runs racing — cannot produce a second fee for the period.
  const key = `late_fee:${lease.leaseId}:${periodKey(period)}`;

  const rentCharge = posted.find(
    (c) =>
      c.kind === "rent" &&
      c.dueOn.getTime() >= periodStart(period).getTime() &&
      c.dueOn.getTime() <= periodEnd(period).getTime(),
  );
  if (!rentCharge) return null;

  const cutoff = addDays(rentCharge.dueOn, lease.lateFee.graceDays);
  if (asOfLocalDate.getTime() <= cutoff.getTime()) return null;

  // Which charges count toward "overdue" depends on configuration.
  const considered = posted.filter(
    (c) =>
      c.dueOn.getTime() <= rentCharge.dueOn.getTime() &&
      (c.kind === "rent" || (lease.lateFee.appliesToWater && c.kind === "water")),
  );

  const settled = applyCredits(
    posted.map((c) => ({ id: c.id, kind: c.kind, amountCents: c.amountCents, dueOn: c.dueOn })),
    totalCreditsCents,
  );

  const overdue = settled
    .filter((s) => considered.some((c) => c.id === s.id))
    .reduce((sum, s) => sum + s.outstandingCents, 0n);

  const amountCents = lateFeeAmount(lease.lateFee, overdue);
  if (amountCents <= 0n) return null;

  return {
    leaseId: lease.leaseId,
    kind: "late_fee",
    amountCents,
    dueOn: asOfLocalDate,
    periodStart: null,
    periodEnd: null,
    description: `Late fee for ${periodKey(period)}`,
    idempotencyKey: key,
    // Late fees follow the same split as rent, but are never prorated.
    allocations: allocate(
      amountCents,
      weightsFor(activeTenants(lease, periodStart(period), periodEnd(period)),
        periodStart(period), periodEnd(period), false),
    ).map((a) => ({ leaseTenantId: a.id, amountCents: a.amountCents })),
  };
}
