import { ownerDb } from "../db.js";

/**
 * Removes everything a test suite created, in dependency order.
 *
 * Written after two suites failed on their own cleanup. Naively deleting users
 * hits `lease_tenant_user_id_fkey` (ON DELETE RESTRICT), and deleting the
 * lease_tenant rows instead tries to null `ledger_entry.lease_tenant_id`, which
 * the append-only trigger refuses. So teardown has to unwind the graph
 * explicitly, with the trigger briefly disabled.
 *
 * Disabling that trigger is acceptable ONLY here. Production corrects a charge
 * with an offsetting entry; nothing outside test teardown should ever turn the
 * ledger's protection off.
 *
 * Idempotent, and safe against a previous run that died halfway.
 */
export async function purgeTestData(emailSuffix: string): Promise<void> {
  const users = await ownerDb().appUser.findMany({
    where: { email: { endsWith: emailSuffix } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) return;

  const [memberships, tenancies] = await Promise.all([
    ownerDb().orgMember.findMany({ where: { userId: { in: userIds } }, select: { orgId: true } }),
    ownerDb().leaseTenant.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, leaseId: true },
    }),
  ]);

  const orgIds = [...new Set(memberships.map((m) => m.orgId))];
  const leaseTenantIds = tenancies.map((t) => t.id);

  // Leases reachable either through a test org's properties or through a test
  // user's tenancy — a suite may have created only one of the two.
  const orgLeases = await ownerDb().lease.findMany({
    where: { unit: { property: { orgId: { in: orgIds } } } },
    select: { id: true, unitId: true },
  });
  const leaseIds = [...new Set([...orgLeases.map((l) => l.id), ...tenancies.map((t) => t.leaseId)])];
  const unitIds = [...new Set(orgLeases.map((l) => l.unitId))];

  await ownerDb().$executeRawUnsafe(
    `alter table ledger_entry disable trigger ledger_entry_no_mutation`,
  );
  try {
    await ownerDb().ledgerEntry.deleteMany({
      where: {
        OR: [{ leaseId: { in: leaseIds } }, { leaseTenantId: { in: leaseTenantIds } }],
      },
    });
    await ownerDb().chargeAllocation.deleteMany({
      where: {
        OR: [{ leaseTenantId: { in: leaseTenantIds } }, { charge: { leaseId: { in: leaseIds } } }],
      },
    });
    await ownerDb().payment.deleteMany({
      where: { OR: [{ leaseId: { in: leaseIds } }, { payerUserId: { in: userIds } }] },
    });
    await ownerDb().charge.deleteMany({ where: { leaseId: { in: leaseIds } } });
    await ownerDb().splitShare.deleteMany({
      where: { OR: [{ leaseTenantId: { in: leaseTenantIds } }, { plan: { leaseId: { in: leaseIds } } }] },
    });
    await ownerDb().splitPlan.deleteMany({ where: { leaseId: { in: leaseIds } } });
    await ownerDb().autopayEnrollment.deleteMany({
      where: { leaseTenantId: { in: leaseTenantIds } },
    });
    await ownerDb().securityDeposit.deleteMany({ where: { leaseId: { in: leaseIds } } });
    await ownerDb().leaseRentPeriod.deleteMany({ where: { leaseId: { in: leaseIds } } });
    await ownerDb().leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } });
    await ownerDb().invitation.deleteMany({
      where: {
        OR: [
          { email: { endsWith: emailSuffix } },
          { leaseId: { in: leaseIds } },
          { orgId: { in: orgIds } },
          { invitedBy: { in: userIds } },
        ],
      },
    });
    await ownerDb().lease.deleteMany({ where: { id: { in: leaseIds } } });
    await ownerDb().unit.deleteMany({ where: { id: { in: unitIds } } });
    await ownerDb().property.deleteMany({ where: { orgId: { in: orgIds } } });
    await ownerDb().orgMember.deleteMany({ where: { orgId: { in: orgIds } } });
    await ownerDb().org.deleteMany({ where: { id: { in: orgIds } } });

    await ownerDb().authCode.deleteMany({ where: { email: { endsWith: emailSuffix } } });
    await ownerDb().session.deleteMany({ where: { userId: { in: userIds } } });
    await ownerDb().paymentMethod.deleteMany({ where: { userId: { in: userIds } } });
    await ownerDb().stripeCustomer.deleteMany({ where: { userId: { in: userIds } } });
    await ownerDb().notificationLog.deleteMany({ where: { userId: { in: userIds } } });
    await ownerDb().appUser.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await ownerDb().$executeRawUnsafe(
      `alter table ledger_entry enable trigger ledger_entry_no_mutation`,
    );
  }
}
