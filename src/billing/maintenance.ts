import { purgeStaleAuthCodes, purgeExpiredSessions } from "../auth/index.js";
import { ownerDb } from "../db.js";
import { notifyDepositDeadline, notifyRentDue } from "../notifications/events.js";
import { addDays, localDateString, parseDate } from "./period.js";

/**
 * Periodic work that is neither charge generation nor payment handling:
 * reminders, statutory clocks, housekeeping, and data-integrity checks.
 *
 * Everything is idempotent and safe to run repeatedly.
 */

/** How far ahead tenants are reminded about rent. */
const RENT_REMINDER_DAYS = [5, 1, 0];

/** Escalating deposit-deadline warnings, in days remaining. */
const DEPOSIT_WARNING_DAYS = [14, 7, 3, 1];

export interface MaintenanceSummary {
  rentRemindersSent: number;
  depositWarningsSent: number;
  authCodesPurged: number;
  sessionsPurged: number;
  /** Leases that cannot be billed correctly — surfaced, not silently skipped. */
  healthIssues: { leaseId: string; issue: string }[];
}

/**
 * Reminds tenants of upcoming rent, at each configured horizon.
 *
 * Works from posted charges rather than recomputing what rent should be, so a
 * tenant is never reminded about an amount that does not exist yet.
 */
export async function sendRentReminders(asOf: Date = new Date()): Promise<number> {
  let sent = 0;

  const upcoming = await ownerDb().charge.findMany({
    where: {
      chargeType: "rent",
      dueOn: { gte: addDays(asOf, -1), lte: addDays(asOf, Math.max(...RENT_REMINDER_DAYS) + 1) },
    },
    select: {
      id: true,
      dueOn: true,
      lease: { select: { unit: { select: { property: { select: { timezone: true } } } } } },
    },
  });

  for (const charge of upcoming) {
    // Compare calendar dates in the property's timezone, not the server's.
    const today = parseDate(
      localDateString(asOf, charge.lease.unit.property.timezone),
    );
    const daysUntil = Math.round(
      (charge.dueOn.getTime() - today.getTime()) / 86_400_000,
    );
    if (!RENT_REMINDER_DAYS.includes(daysUntil)) continue;

    sent += await notifyRentDue(charge.id, daysUntil);
  }

  return sent;
}

/**
 * Warns the landlord as a deposit return deadline approaches.
 *
 * In Pennsylvania, missing the 30-day window forfeits the right to withhold any
 * of the deposit and exposes the landlord to double damages — which is why this
 * escalates rather than firing once.
 */
export async function sendDepositDeadlineWarnings(asOf: Date = new Date()): Promise<number> {
  let sent = 0;

  const open = await ownerDb().securityDeposit.findMany({
    where: { returnedOn: null, returnDueOn: { not: null } },
    select: { id: true, returnDueOn: true },
  });

  for (const deposit of open) {
    const daysRemaining = Math.ceil(
      (deposit.returnDueOn!.getTime() - asOf.getTime()) / 86_400_000,
    );
    // Past due is its own alarm; keep warning at the tightest threshold.
    const threshold = DEPOSIT_WARNING_DAYS.find((d) => d === daysRemaining);
    if (threshold === undefined) continue;

    sent += await notifyDepositDeadline(deposit.id, threshold);
  }

  return sent;
}

/**
 * Flags leases that would silently produce nothing during billing.
 *
 * Deliberately a check rather than a database constraint: a lease has to exist
 * before tenants and rent can be attached to it, so a constraint would make the
 * normal creation order impossible. Instead the nightly run reports these, and
 * the alert email makes them visible.
 */
export async function checkLeaseHealth(): Promise<{ leaseId: string; issue: string }[]> {
  const issues: { leaseId: string; issue: string }[] = [];

  const active = await ownerDb().lease.findMany({
    where: { status: "active" },
    select: {
      id: true,
      _count: { select: { rentPeriods: true, tenants: true } },
      securityDeposit: { select: { id: true } },
      securityDepositCents: true,
    },
  });

  for (const lease of active) {
    if (lease._count.rentPeriods === 0) {
      issues.push({ leaseId: lease.id, issue: "active lease has no rent period; no rent will be charged" });
    }
    if (lease._count.tenants === 0) {
      issues.push({ leaseId: lease.id, issue: "active lease has no tenants; charges cannot be allocated" });
    }
    if (lease.securityDepositCents > 0n && !lease.securityDeposit) {
      issues.push({
        leaseId: lease.id,
        issue: "lease records a deposit amount but has no security_deposit row to track escrow and the return deadline",
      });
    }
  }

  return issues;
}

/**
 * Sets the statutory return deadline when a tenancy ends.
 *
 * Derived from the jurisdiction ruleset rather than hardcoded, and only ever
 * set once — moving the deadline after the fact would defeat its purpose.
 */
export async function scheduleDepositReturns(asOf: Date = new Date()): Promise<number> {
  const { returnDeadlineDays } = await import("../jurisdictions.js");
  let updated = 0;

  const candidates = await ownerDb().securityDeposit.findMany({
    where: { returnDueOn: null, returnedOn: null },
    select: {
      id: true,
      lease: {
        select: {
          status: true,
          endsOn: true,
          unit: { select: { property: { select: { jurisdictionId: true } } } },
          tenants: { select: { movedOutOn: true } },
        },
      },
    },
  });

  for (const deposit of candidates) {
    const lease = deposit.lease;
    const moveOuts = lease.tenants.map((t) => t.movedOutOn).filter((d): d is Date => d !== null);

    // The clock starts at the LAST move-out, or the lease end date.
    const ended =
      lease.status === "ended" || (lease.endsOn !== null && lease.endsOn.getTime() <= asOf.getTime());
    if (!ended) continue;

    const allMovedOut = lease.tenants.length > 0 && moveOuts.length === lease.tenants.length;
    const clockStart = allMovedOut
      ? new Date(Math.max(...moveOuts.map((d) => d.getTime())))
      : lease.endsOn;
    if (!clockStart) continue;

    const days = await returnDeadlineDays(lease.unit.property.jurisdictionId);
    await ownerDb().securityDeposit.update({
      where: { id: deposit.id },
      data: { returnDueOn: addDays(clockStart, days) },
    });
    updated++;
  }

  return updated;
}

export async function runMaintenance(asOf: Date = new Date()): Promise<MaintenanceSummary> {
  await scheduleDepositReturns(asOf);

  const [rentRemindersSent, depositWarningsSent, authCodesPurged, sessionsPurged, healthIssues] =
    await Promise.all([
      sendRentReminders(asOf),
      sendDepositDeadlineWarnings(asOf),
      purgeStaleAuthCodes(),
      purgeExpiredSessions(),
      checkLeaseHealth(),
    ]);

  return { rentRemindersSent, depositWarningsSent, authCodesPurged, sessionsPurged, healthIssues };
}
