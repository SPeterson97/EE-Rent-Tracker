/**
 * Notifications suite. Run with:  npm run notifications:check
 *
 * The property that matters most is that nothing double-sends. Jobs re-run,
 * webhooks redeliver, and a duplicate "your payment failed" is worse than a
 * missing one.
 */
import { randomUUID } from "node:crypto";
import { sessionPolicy, validateSession } from "./auth/index.js";
import { checkLeaseHealth, sendDepositDeadlineWarnings, sendRentReminders } from "./billing/maintenance.js";
import { addDays, localDateString, parseDate, utcDate } from "./billing/period.js";
import { ownerDb } from "./db.js";
import { CapturingMailer, setMailer } from "./email/mailer.js";
import { returnDeadlineDays, resolveRules } from "./jurisdictions.js";
import { notifyLateFee, notifyPaymentFailed, notifyPaymentReceived } from "./notifications/events.js";
import { notify } from "./notifications/send.js";
import { purgeTestData } from "./testing/cleanup.js";

const mail = new CapturingMailer();
const LEASE = "a0000000-0000-0000-0000-000000000003";
const TAM = "33333333-3333-3333-3333-333333333333";

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = "") {
  checks++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function clearNotifications() {
  await ownerDb().notificationLog.deleteMany({});
  mail.clear();
}

async function main() {
  setMailer(mail);
  await clearNotifications();

  // -------------------------------------------------------------------
  section("dedupe: the same event never sends twice");

  const key = `test:${randomUUID()}`;
  const first = await notify({
    userId: TAM,
    kind: "rent_due",
    dedupeKey: key,
    message: { to: "tam@tenant.test", subject: "First", text: "body" },
  });
  const second = await notify({
    userId: TAM,
    kind: "rent_due",
    dedupeKey: key,
    message: { to: "tam@tenant.test", subject: "Second", text: "body" },
  });
  check("first send goes out", first.sent);
  check("second is suppressed", !second.sent && second.reason === "duplicate");
  check("only one email left the building", mail.sent.length === 1, `${mail.sent.length}`);

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      notify({
        userId: TAM,
        kind: "rent_due",
        dedupeKey: `race:${randomUUID().slice(0, 8)}-fixed`,
        message: { to: "tam@tenant.test", subject: "Race", text: "body" },
      }),
    ),
  );
  check("distinct keys all send", concurrent.filter((r) => r.sent).length === 8);

  mail.clear();
  const sameKey = `concurrent:${randomUUID()}`;
  const raced = await Promise.all(
    Array.from({ length: 8 }, () =>
      notify({
        userId: TAM,
        kind: "rent_due",
        dedupeKey: sameKey,
        message: { to: "tam@tenant.test", subject: "Race", text: "body" },
      }),
    ),
  );
  check(
    "8 concurrent sends of ONE key produce exactly one email",
    raced.filter((r) => r.sent).length === 1 && mail.sent.length === 1,
    `${mail.sent.length} emails`,
  );

  // -------------------------------------------------------------------
  section("payment notifications");

  await clearNotifications();
  const payment = await ownerDb().payment.create({
    data: {
      leaseId: LEASE,
      payerUserId: TAM,
      amountCents: 126000n,
      channel: "ach",
      status: "succeeded",
      idempotencyKey: `notif-${randomUUID()}`,
    },
    select: { id: true },
  });

  await notifyPaymentReceived(payment.id);
  check("receipt sent on settlement", mail.sent.length === 1);
  check("receipt names the amount", mail.last()?.text.includes("$1,260.00") === true, mail.last()?.subject);

  await notifyPaymentReceived(payment.id);
  check("re-notifying the same payment sends nothing", mail.sent.length === 1);

  mail.clear();
  await ownerDb().payment.update({
    where: { id: payment.id },
    data: { failureMessage: "Insufficient funds.", failureCode: "insufficient_funds" },
  });

  await notifyPaymentFailed(payment.id, { afterSettlement: false });
  check("decline notice sent", mail.sent.length === 1);
  check(
    "decline wording says nothing was collected",
    mail.last()?.text.includes("declined the transfer") === true,
  );

  // A return AFTER settlement is a materially different message, and must not
  // be suppressed by the earlier decline notice.
  await notifyPaymentFailed(payment.id, { afterSettlement: true });
  check("post-settlement return also notifies", mail.sent.length === 2, `${mail.sent.length}`);
  check(
    "return wording explains the balance went back up",
    mail.last()?.text.includes("has since returned it") === true,
  );

  // -------------------------------------------------------------------
  section("late fee notification reaches every tenant");

  await clearNotifications();
  const feeCharge = await ownerDb().charge.create({
    data: {
      leaseId: LEASE,
      chargeType: "late_fee",
      amountCents: 10500n,
      dueOn: utcDate(2026, 12, 10),
      description: "Late fee for 2026-12",
      idempotencyKey: `notif-fee-${randomUUID()}`,
    },
    select: { id: true },
  });
  await notifyLateFee(feeCharge.id);
  check("both tenants on the lease are told", mail.sent.length === 2, `${mail.sent.length}`);
  await notifyLateFee(feeCharge.id);
  check("re-running sends nothing further", mail.sent.length === 2);

  // -------------------------------------------------------------------
  section("rent reminders");

  await clearNotifications();
  // Build the due date from the LOCAL calendar date, exactly as the reminder
  // does. Deriving it from UTC is off by one whenever the server has already
  // rolled over to tomorrow while the property has not.
  const todayLocal = parseDate(localDateString(new Date(), "America/New_York"));
  const dueOn = addDays(todayLocal, 5);
  const rentCharge = await ownerDb().charge.create({
    data: {
      leaseId: LEASE,
      chargeType: "rent",
      amountCents: 210000n,
      dueOn,
      description: "Rent reminder test",
      idempotencyKey: `notif-rent-${randomUUID()}`,
      allocations: {
        create: [
          { leaseTenantId: "a0000000-0000-0000-0000-000000000004", amountCents: 126000n },
          { leaseTenantId: "a0000000-0000-0000-0000-000000000005", amountCents: 84000n },
        ],
      },
    },
    select: { id: true },
  });

  const sent = await sendRentReminders(new Date());
  check("reminders sent at the 5-day horizon", sent === 2, `${sent}`);
  check(
    "each tenant sees their OWN share, not the whole charge",
    mail.sent.some((m) => m.text.includes("$1,260.00")) &&
      mail.sent.some((m) => m.text.includes("$840.00")),
    mail.sent.map((m) => m.subject).join(" | "),
  );

  const again = await sendRentReminders(new Date());
  check("running again sends nothing", again === 0, `${again}`);

  // -------------------------------------------------------------------
  section("deposit deadline escalation");

  await clearNotifications();
  const deposit = await ownerDb().securityDeposit.upsert({
    where: { leaseId: LEASE },
    create: { leaseId: LEASE, amountCents: 240000n, returnDueOn: addDays(new Date(), 7) },
    update: { returnDueOn: addDays(new Date(), 7), returnedOn: null },
    select: { id: true },
  });

  const warned = await sendDepositDeadlineWarnings(new Date());
  check("landlord warned at the 7-day threshold", warned === 1, `${warned}`);
  check(
    "warning cites the double-damages exposure",
    mail.last()?.text.includes("double") === true,
  );

  const warnedAgain = await sendDepositDeadlineWarnings(new Date());
  check("same threshold does not repeat", warnedAgain === 0);

  await ownerDb().securityDeposit.update({
    where: { id: deposit.id },
    data: { returnDueOn: addDays(new Date(), 3) },
  });
  const escalated = await sendDepositDeadlineWarnings(new Date());
  check("a tighter threshold escalates", escalated === 1, `${escalated}`);
  check("urgent wording appears", mail.last()?.subject.startsWith("URGENT") === true, mail.last()?.subject);

  // -------------------------------------------------------------------
  section("jurisdiction rules drive the deadline");

  const paDays = await returnDeadlineDays("us-pa-pittsburgh");
  check("Pittsburgh inherits PA's 30-day return window", paDays === 30, `${paDays}`);
  const rules = await resolveRules("us-pa-pittsburgh");
  check("city rules inherit state rules", rules.length >= 9, `${rules.length} rules`);
  check(
    "unknown jurisdictions fall back safely",
    (await returnDeadlineDays("us-zz-nowhere")) === 30,
  );

  // -------------------------------------------------------------------
  section("lease health checks");

  const issues = await checkLeaseHealth();
  check("seeded leases are healthy", issues.length === 0, JSON.stringify(issues));

  const orphan = await ownerDb().lease.create({
    data: {
      unitId: "a0000000-0000-0000-0000-000000000002",
      status: "active",
      startsOn: utcDate(2026, 1, 1),
    },
    select: { id: true },
  });
  const withOrphan = await checkLeaseHealth();
  check(
    "a lease with no rent period is flagged",
    withOrphan.some((i) => i.leaseId === orphan.id && i.issue.includes("no rent period")),
  );
  check(
    "a lease with no tenants is flagged",
    withOrphan.some((i) => i.leaseId === orphan.id && i.issue.includes("no tenants")),
  );
  await ownerDb().lease.delete({ where: { id: orphan.id } });

  // -------------------------------------------------------------------
  section("session idle timeout");

  const idleUser = await ownerDb().appUser.create({
    data: { email: `idle-${randomUUID().slice(0, 8)}@notifcheck.test` },
    select: { id: true },
  });
  const { createSession } = await import("./auth/index.js");
  const session = await createSession(idleUser.id);
  check("fresh session validates", (await validateSession(session.token)) !== null);

  await ownerDb().session.updateMany({
    where: { userId: idleUser.id },
    data: { lastSeenAt: addDays(new Date(), -(sessionPolicy.IDLE_TIMEOUT_DAYS + 1)) },
  });
  check("idle session stops validating", (await validateSession(session.token)) === null);

  const revoked = await ownerDb().session.findFirst({ where: { userId: idleUser.id } });
  check("...and is revoked, not merely rejected", revoked?.revokedAt !== null);

  // -------------------------------------------------------------------
  await ownerDb().$executeRawUnsafe(
    `alter table ledger_entry disable trigger ledger_entry_no_mutation`,
  );
  try {
    await ownerDb().chargeAllocation.deleteMany({
      where: { chargeId: { in: [rentCharge.id, feeCharge.id] } },
    });
    await ownerDb().charge.deleteMany({ where: { id: { in: [rentCharge.id, feeCharge.id] } } });
    await ownerDb().payment.deleteMany({ where: { id: payment.id } });
  } finally {
    await ownerDb().$executeRawUnsafe(
      `alter table ledger_entry enable trigger ledger_entry_no_mutation`,
    );
  }
  // Restore the seeded deposit rather than deleting it — lease health checks
  // (correctly) flag a lease that records a deposit amount with no tracking row.
  await ownerDb().securityDeposit.update({
    where: { leaseId: LEASE },
    data: { returnDueOn: null, returnedOn: null },
  });
  await purgeTestData("@notifcheck.test");
  await clearNotifications();

  console.log(
    failures === 0
      ? `\nAll ${checks} notification checks passed.\n`
      : `\n${failures} of ${checks} notification checks FAILED.\n`,
  );
  await ownerDb().$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
