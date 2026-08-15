import { ownerDb } from "../db.js";
import { notify } from "./send.js";
import {
  depositDeadlineEmail,
  lateFeeEmail,
  paymentFailedEmail,
  paymentReceivedEmail,
  rentDueEmail,
} from "./templates.js";

/**
 * Domain events to notifications.
 *
 * Every function here is safe to call more than once — the dedupe key is
 * derived from the event, not from the moment of calling. Webhooks redeliver
 * and the nightly job re-runs, so "call it again" has to be harmless.
 *
 * None of these throw. A notification failing must never roll back the money
 * movement that triggered it.
 */

async function leaseContext(leaseId: string) {
  const lease = await ownerDb().lease.findUnique({
    where: { id: leaseId },
    select: {
      unit: { select: { label: true, property: { select: { name: true } } } },
      tenants: {
        where: { movedOutOn: null },
        select: { userId: true, user: { select: { email: true } } },
      },
    },
  });
  if (!lease) return null;
  return {
    unitLabel: `${lease.unit.property.name} ${lease.unit.label}`,
    tenants: lease.tenants,
  };
}

async function leaseBalance(leaseId: string): Promise<bigint> {
  const row = await ownerDb().leaseBalance.findFirst({ where: { leaseId } });
  return row?.balanceCents ?? 0n;
}

/** Receipt for a settled payment. Sent to the payer, not the whole lease. */
export async function notifyPaymentReceived(paymentId: string): Promise<void> {
  try {
    const payment = await ownerDb().payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        leaseId: true,
        amountCents: true,
        payerUserId: true,
        payer: { select: { email: true } },
      },
    });
    if (!payment?.payerUserId || !payment.payer) return;

    const context = await leaseContext(payment.leaseId);
    if (!context) return;

    await notify({
      userId: payment.payerUserId,
      kind: "payment_received",
      dedupeKey: `payment_received:${payment.id}`,
      message: paymentReceivedEmail({
        to: payment.payer.email,
        amountCents: payment.amountCents,
        unitLabel: context.unitLabel,
        remainingCents: await leaseBalance(payment.leaseId),
      }),
    });
  } catch (error) {
    console.error("[notifications] payment received:", error);
  }
}

/**
 * A payment failed or was returned.
 *
 * `afterSettlement` changes the message materially: a tenant whose ACH was
 * returned weeks later believes they are paid up, and needs to be told their
 * balance went back up rather than that a transfer was declined.
 */
export async function notifyPaymentFailed(
  paymentId: string,
  options: { afterSettlement: boolean },
): Promise<void> {
  try {
    const payment = await ownerDb().payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        leaseId: true,
        amountCents: true,
        payerUserId: true,
        failureMessage: true,
        failureCode: true,
        payer: { select: { email: true } },
      },
    });
    if (!payment?.payerUserId || !payment.payer) return;

    const context = await leaseContext(payment.leaseId);
    if (!context) return;

    await notify({
      userId: payment.payerUserId,
      kind: "payment_failed",
      // Keyed on the outcome as well as the payment: a payment can fail during
      // processing and, in principle, be reversed later.
      dedupeKey: `payment_failed:${payment.id}:${options.afterSettlement ? "returned" : "declined"}`,
      message: paymentFailedEmail({
        to: payment.payer.email,
        amountCents: payment.amountCents,
        unitLabel: context.unitLabel,
        reason: payment.failureMessage ?? payment.failureCode,
        afterSettlement: options.afterSettlement,
      }),
    });
  } catch (error) {
    console.error("[notifications] payment failed:", error);
  }
}

/** Everyone on the lease is told — the fee is a joint obligation. */
export async function notifyLateFee(chargeId: string): Promise<void> {
  try {
    const charge = await ownerDb().charge.findUnique({
      where: { id: chargeId },
      select: { id: true, leaseId: true, amountCents: true, description: true },
    });
    if (!charge) return;

    const context = await leaseContext(charge.leaseId);
    if (!context) return;

    const balance = await leaseBalance(charge.leaseId);

    for (const tenant of context.tenants) {
      await notify({
        userId: tenant.userId,
        kind: "late_fee_posted",
        dedupeKey: `late_fee_posted:${charge.id}:${tenant.userId}`,
        message: lateFeeEmail({
          to: tenant.user.email,
          amountCents: charge.amountCents,
          unitLabel: context.unitLabel,
          period: charge.description ?? "",
          balanceCents: balance,
        }),
      });
    }
  } catch (error) {
    console.error("[notifications] late fee:", error);
  }
}

/**
 * Upcoming rent, sent to each tenant with their own allocated share rather than
 * the whole charge — telling someone they owe $2,100 when their share is $840
 * causes more support mail than it prevents.
 */
export async function notifyRentDue(chargeId: string, daysUntil: number): Promise<number> {
  let sent = 0;
  try {
    const charge = await ownerDb().charge.findUnique({
      where: { id: chargeId },
      select: {
        id: true,
        leaseId: true,
        dueOn: true,
        amountCents: true,
        allocations: {
          select: {
            amountCents: true,
            tenant: { select: { userId: true, movedOutOn: true, user: { select: { email: true } } } },
          },
        },
      },
    });
    if (!charge) return 0;

    const context = await leaseContext(charge.leaseId);
    if (!context) return 0;

    for (const allocation of charge.allocations) {
      if (allocation.tenant.movedOutOn) continue;
      const result = await notify({
        userId: allocation.tenant.userId,
        kind: "rent_due",
        dedupeKey: `rent_due:${charge.id}:${allocation.tenant.userId}:${daysUntil}`,
        message: rentDueEmail({
          to: allocation.tenant.user.email,
          unitLabel: context.unitLabel,
          amountCents: allocation.amountCents,
          dueOn: charge.dueOn,
          daysUntil,
        }),
      });
      if (result.sent) sent++;
    }
  } catch (error) {
    console.error("[notifications] rent due:", error);
  }
  return sent;
}

/** Landlord-facing deposit deadline warning. */
export async function notifyDepositDeadline(
  depositId: string,
  daysRemaining: number,
): Promise<number> {
  let sent = 0;
  try {
    const deposit = await ownerDb().securityDeposit.findUnique({
      where: { id: depositId },
      select: {
        id: true,
        amountCents: true,
        returnDueOn: true,
        lease: {
          select: {
            unit: {
              select: {
                label: true,
                property: {
                  select: {
                    name: true,
                    org: {
                      select: {
                        members: {
                          where: { role: "owner" },
                          select: { userId: true, user: { select: { email: true } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!deposit?.returnDueOn) return 0;

    const property = deposit.lease.unit.property;
    const unitLabel = `${property.name} ${deposit.lease.unit.label}`;

    for (const owner of property.org.members) {
      const result = await notify({
        userId: owner.userId,
        kind: "deposit_deadline",
        // Keyed on the threshold so the reminder escalates rather than repeats.
        dedupeKey: `deposit_deadline:${deposit.id}:${daysRemaining}`,
        message: depositDeadlineEmail({
          to: owner.user.email,
          unitLabel,
          dueOn: deposit.returnDueOn,
          daysRemaining,
          amountCents: deposit.amountCents,
        }),
      });
      if (result.sent) sent++;
    }
  } catch (error) {
    console.error("[notifications] deposit deadline:", error);
  }
  return sent;
}
