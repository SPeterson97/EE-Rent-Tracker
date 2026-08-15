/**
 * The database side of billing: load a snapshot, call the pure planners, write
 * the result. All the decisions live in plan.ts; this file is deliberately
 * mechanical.
 *
 * Runs through ownerDb because it acts across every tenant — it is a system
 * job, not a user request, and there is no current user to scope RLS against.
 */
import type { Prisma } from "@prisma/client";
import { alertJobFailure } from "../alerts.js";
import { ownerDb } from "../db.js";
import { localPeriod, parseDate, periodKey, type BillingPeriod } from "./period.js";
import {
  planLateFee,
  planRent,
  planWater,
  type LeaseSnapshot,
  type PlannedCharge,
  type PostedCharge,
  type WaterBillInput,
} from "./plan.js";

export interface PostResult {
  chargeId: string | null;
  created: boolean;
  reason?: "duplicate" | "nothing_owed";
}

/**
 * Writes a planned charge, its per-tenant allocations, and the ledger entry as
 * one transaction. A charge without its ledger entry would be invisible to the
 * balance; a ledger entry without its charge would be unexplainable.
 */
export async function postCharge(
  planned: PlannedCharge,
  tx?: Prisma.TransactionClient,
): Promise<PostResult> {
  const run = async (client: Prisma.TransactionClient): Promise<PostResult> => {
    const charge = await client.charge.create({
      data: {
        leaseId: planned.leaseId,
        chargeType: planned.kind,
        amountCents: planned.amountCents,
        dueOn: planned.dueOn,
        periodStart: planned.periodStart,
        periodEnd: planned.periodEnd,
        description: planned.description,
        idempotencyKey: planned.idempotencyKey,
      },
      select: { id: true },
    });

    if (planned.allocations.length > 0) {
      await client.chargeAllocation.createMany({
        data: planned.allocations.map((a) => ({
          chargeId: charge.id,
          leaseTenantId: a.leaseTenantId,
          amountCents: a.amountCents,
        })),
      });
    }

    await client.ledgerEntry.create({
      data: {
        leaseId: planned.leaseId,
        entryType: "charge",
        amountCents: planned.amountCents,
        chargeId: charge.id,
        effectiveOn: planned.dueOn,
        memo: planned.description,
      },
    });

    return { chargeId: charge.id, created: true };
  };

  try {
    return tx ? await run(tx) : await ownerDb().$transaction(run);
  } catch (error) {
    // A duplicate idempotency key is the expected outcome of a re-run, not a
    // failure. This is the constraint doing its job.
    if (isUniqueViolation(error)) {
      return { chargeId: null, created: false, reason: "duplicate" };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

const LEASE_INCLUDE = {
  unit: { select: { property: true } },
  rentPeriods: { select: { effectiveFrom: true, rentCents: true } },
  tenants: {
    select: { id: true, movedInOn: true, movedOutOn: true },
  },
  splitPlans: {
    where: { status: "active" as const },
    select: {
      chargeType: true,
      shares: {
        select: { leaseTenantId: true, percentBps: true, absorbsRemainder: true },
      },
    },
  },
} satisfies Prisma.LeaseInclude;

type LeaseRow = Prisma.LeaseGetPayload<{ include: typeof LEASE_INCLUDE }>;

function toSnapshot(lease: LeaseRow, chargeType: "rent" | "water"): LeaseSnapshot {
  const property = lease.unit.property;
  const plan = lease.splitPlans.find((p) => p.chargeType === chargeType);

  return {
    leaseId: lease.id,
    status: lease.status,
    startsOn: lease.startsOn,
    endsOn: lease.endsOn,
    rentDueDay: lease.rentDueDay,
    timezone: property.timezone,
    rentPeriods: lease.rentPeriods,
    tenants: lease.tenants.map((t) => {
      const share = plan?.shares.find((s) => s.leaseTenantId === t.id);
      return {
        leaseTenantId: t.id,
        // A tenant with no recorded move-in is treated as present from the
        // lease start, which is the common case for an original signer.
        startsOn: t.movedInOn ?? lease.startsOn,
        endsOn: t.movedOutOn ?? lease.endsOn,
        shareBps: share?.percentBps ?? null,
        absorbsRemainder: share?.absorbsRemainder ?? false,
      };
    }),
    lateFee: {
      kind: property.lateFeeKind,
      value: property.lateFeeValue,
      capCents: property.lateFeeCapCents,
      graceDays: property.lateFeeGraceDays,
      appliesToWater: property.lateFeeAppliesToWater,
    },
  };
}

async function loadLease(leaseId: string): Promise<LeaseRow | null> {
  return ownerDb().lease.findUnique({ where: { id: leaseId }, include: LEASE_INCLUDE });
}

async function loadActiveLeases(): Promise<LeaseRow[]> {
  return ownerDb().lease.findMany({ where: { status: "active" }, include: LEASE_INCLUDE });
}

export interface RunSummary {
  rentCreated: number;
  rentSkipped: number;
  lateFeesCreated: number;
  lateFeesSkipped: number;
  errors: { leaseId: string; stage: string; message: string }[];
}

/**
 * Generates rent for a period across every active lease.
 *
 * `period` is explicit rather than derived from "now" so the job can be re-run
 * for a past month, and so tests do not depend on the calendar.
 */
export async function generateRent(period: BillingPeriod): Promise<RunSummary> {
  const summary: RunSummary = {
    rentCreated: 0,
    rentSkipped: 0,
    lateFeesCreated: 0,
    lateFeesSkipped: 0,
    errors: [],
  };

  for (const lease of await loadActiveLeases()) {
    try {
      const planned = planRent(toSnapshot(lease, "rent"), period);
      if (!planned) {
        summary.rentSkipped++;
        continue;
      }
      const result = await postCharge(planned);
      if (result.created) summary.rentCreated++;
      else summary.rentSkipped++;
    } catch (error) {
      // One bad lease must not abort the run for everyone else.
      summary.errors.push({
        leaseId: lease.id,
        stage: "rent",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

/**
 * Assesses late fees for a period.
 *
 * `asOf` defaults to now, but is converted to a calendar date in each
 * property's own timezone before any comparison — "late after the 5th" is local
 * to the property, not to the server.
 */
export async function assessLateFees(
  period: BillingPeriod,
  asOf: Date = new Date(),
): Promise<RunSummary> {
  const summary: RunSummary = {
    rentCreated: 0,
    rentSkipped: 0,
    lateFeesCreated: 0,
    lateFeesSkipped: 0,
    errors: [],
  };

  for (const lease of await loadActiveLeases()) {
    try {
      const snapshot = toSnapshot(lease, "rent");
      const localToday = parseDate(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: snapshot.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(asOf),
      );

      const [charges, credits] = await Promise.all([
        ownerDb().charge.findMany({
          where: { leaseId: lease.id },
          select: { id: true, chargeType: true, amountCents: true, dueOn: true },
        }),
        ownerDb().ledgerEntry.aggregate({
          where: { leaseId: lease.id, entryType: { in: ["payment", "credit", "waiver"] } },
          _sum: { amountCents: true },
        }),
      ]);

      const posted: PostedCharge[] = charges.map((c) => ({
        id: c.id,
        kind: c.chargeType,
        amountCents: c.amountCents,
        dueOn: c.dueOn,
      }));

      // Credits are stored negative; flip to a positive pool.
      const creditPool = -(credits._sum.amountCents ?? 0n);

      const planned = planLateFee(snapshot, period, posted, creditPool, localToday);
      if (!planned) {
        summary.lateFeesSkipped++;
        continue;
      }
      const result = await postCharge(planned);
      if (result.created) summary.lateFeesCreated++;
      else summary.lateFeesSkipped++;
    } catch (error) {
      summary.errors.push({
        leaseId: lease.id,
        stage: "late_fee",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

/** Records a utility bill against one lease and rebills the tenants. */
export async function recordWaterBill(
  leaseId: string,
  bill: WaterBillInput & { documentUrl?: string | null },
): Promise<PostResult> {
  const lease = await loadLease(leaseId);
  if (!lease) throw new Error(`lease ${leaseId} not found`);

  const planned = planWater(toSnapshot(lease, "water"), bill);
  if (!planned) return { chargeId: null, created: false, reason: "nothing_owed" };

  const result = await postCharge(planned);

  if (result.created && bill.documentUrl) {
    await ownerDb().charge.update({
      where: { id: result.chargeId! },
      data: { documentUrl: bill.documentUrl },
    });
  }

  return result;
}

/**
 * The nightly entry point: generate the current month's rent, then assess late
 * fees for the current and previous month. The previous month matters because a
 * fee only becomes due after the grace period, which routinely lands in the
 * following month.
 */
export async function runNightly(asOf: Date = new Date()): Promise<RunSummary> {
  const startedAt = new Date();
  try {
    const summary = await runNightlyInner(asOf);
    if (summary.errors.length > 0) {
      await alertJobFailure({
        job: "billing:runNightly",
        startedAt,
        itemErrors: summary.errors,
        context: {
          asOf: asOf.toISOString(),
          rentCreated: summary.rentCreated,
          lateFeesCreated: summary.lateFeesCreated,
        },
      });
    }
    return summary;
  } catch (error) {
    // A total failure means no rent was charged at all this run — the loudest
    // possible thing short of paging.
    await alertJobFailure({
      job: "billing:runNightly",
      startedAt,
      fatal: error,
      context: { asOf: asOf.toISOString() },
    });
    throw error;
  }
}

async function runNightlyInner(asOf: Date): Promise<RunSummary> {
  // Any property's timezone will do for choosing which month to bill; the
  // per-lease comparisons below re-derive it correctly for each property.
  const anyProperty = await ownerDb().property.findFirst({ select: { timezone: true } });
  const period = localPeriod(asOf, anyProperty?.timezone ?? "America/New_York");
  const previous: BillingPeriod =
    period.month === 1
      ? { year: period.year - 1, month: 12 }
      : { year: period.year, month: period.month - 1 };

  const rent = await generateRent(period);
  const current = await assessLateFees(period, asOf);
  const prior = await assessLateFees(previous, asOf);

  return {
    rentCreated: rent.rentCreated,
    rentSkipped: rent.rentSkipped,
    lateFeesCreated: current.lateFeesCreated + prior.lateFeesCreated,
    lateFeesSkipped: current.lateFeesSkipped + prior.lateFeesSkipped,
    errors: [...rent.errors, ...current.errors, ...prior.errors],
  };
}

const isEntrypoint =
  process.argv[1]?.endsWith("run.ts") || process.argv[1]?.endsWith("run.js");

if (isEntrypoint) {
  const arg = process.argv[2];
  const asOf = arg ? new Date(`${arg}T12:00:00Z`) : new Date();
  runNightly(asOf)
    .then((summary) => {
      console.log(JSON.stringify({ asOf: asOf.toISOString(), ...summary }, null, 2));
      return ownerDb().$disconnect();
    })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { periodKey };
