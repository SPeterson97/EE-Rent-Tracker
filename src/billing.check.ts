/**
 * Billing suite. Run with:  npm run billing:check
 *
 * Part 1 is pure arithmetic with no database — the split math, the payment
 * waterfall, proration, and timezone handling. Part 2 exercises the job against
 * real data, including running it twice to prove idempotency.
 */
import { allocate, applyCredits, lateFeeAmount } from "./billing/allocate.js";
import {
  daysInMonth,
  dueDateFor,
  localDateString,
  localPeriod,
  occupiedDays,
  parseDate,
  utcDate,
} from "./billing/period.js";
import { planLateFee, planRent, planWater, type LeaseSnapshot } from "./billing/plan.js";
import { assessLateFees, generateRent, recordWaterBill } from "./billing/run.js";
import { asUser, ownerDb } from "./db.js";

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

const D = (s: string) => parseDate(s);

// ---------------------------------------------------------------------------
function pureChecks() {
  section("split allocation reconciles exactly");

  const thirds = allocate(200000n, [
    { id: "a", weight: 10000 / 3, absorbsRemainder: true },
    { id: "b", weight: 10000 / 3 },
    { id: "c", weight: 10000 / 3 },
  ]);
  const total = thirds.reduce((s, a) => s + a.amountCents, 0n);
  check("$2000 split three ways sums to exactly $2000", total === 200000n, `${total}`);
  check(
    "remainder goes to the designated absorber",
    thirds.find((a) => a.id === "a")!.amountCents === 66668n,
    `${thirds.map((a) => a.amountCents).join("/")}`,
  );

  const sixtyForty = allocate(210000n, [
    { id: "x", weight: 6000, absorbsRemainder: true },
    { id: "y", weight: 4000 },
  ]);
  check(
    "60/40 of $2100 is $1260/$840",
    sixtyForty[0]!.amountCents === 126000n && sixtyForty[1]!.amountCents === 84000n,
  );

  // Adversarial: a total that cannot divide evenly by any share.
  const awkward = allocate(100n, [
    { id: "a", weight: 3333 },
    { id: "b", weight: 3333 },
    { id: "c", weight: 3334, absorbsRemainder: true },
  ]);
  check(
    "awkward totals still reconcile",
    awkward.reduce((s, a) => s + a.amountCents, 0n) === 100n,
  );

  check("no weights yields no allocations", allocate(1000n, []).length === 0);
  check(
    "zero-weight tenants are excluded",
    allocate(1000n, [{ id: "a", weight: 0 }, { id: "b", weight: 100 }]).length === 1,
  );

  const unordered = allocate(1000n, [
    { id: "b", weight: 5000 },
    { id: "a", weight: 5000 },
  ]);
  const reordered = allocate(1000n, [
    { id: "a", weight: 5000 },
    { id: "b", weight: 5000 },
  ]);
  check(
    "result does not depend on input ordering",
    unordered.find((a) => a.id === "a")!.amountCents ===
      reordered.find((a) => a.id === "a")!.amountCents,
  );

  section("payment waterfall: rent first, fees last");

  const settled = applyCredits(
    [
      { id: "fee", kind: "late_fee", amountCents: 5000n, dueOn: D("2026-09-01") },
      { id: "rent", kind: "rent", amountCents: 210000n, dueOn: D("2026-09-01") },
      { id: "water", kind: "water", amountCents: 8000n, dueOn: D("2026-09-01") },
    ],
    210000n,
  );
  const rent = settled.find((s) => s.id === "rent")!;
  const fee = settled.find((s) => s.id === "fee")!;
  check("rent is settled before fees", rent.outstandingCents === 0n);
  check("the fee remains outstanding", fee.outstandingCents === 5000n);

  const older = applyCredits(
    [
      { id: "sep", kind: "rent", amountCents: 100000n, dueOn: D("2026-09-01") },
      { id: "aug", kind: "rent", amountCents: 100000n, dueOn: D("2026-08-01") },
    ],
    100000n,
  );
  check(
    "oldest charge is settled first",
    older.find((s) => s.id === "aug")!.outstandingCents === 0n &&
      older.find((s) => s.id === "sep")!.outstandingCents === 100000n,
  );

  const overpaid = applyCredits(
    [{ id: "r", kind: "rent", amountCents: 1000n, dueOn: D("2026-09-01") }],
    5000n,
  );
  check("overpayment does not go negative", overpaid[0]!.outstandingCents === 0n);

  section("late fee amounts");

  check(
    "5% of $2100 overdue is $105",
    lateFeeAmount({ kind: "percent_of_rent", value: 5n, capCents: null }, 210000n) === 10500n,
  );
  check(
    "cap is honoured",
    lateFeeAmount({ kind: "percent_of_rent", value: 5n, capCents: 5000n }, 210000n) === 5000n,
  );
  check(
    "flat fee ignores the overdue amount",
    lateFeeAmount({ kind: "flat", value: 5000n, capCents: null }, 210000n) === 5000n,
  );
  check(
    "nothing overdue means no fee",
    lateFeeAmount({ kind: "flat", value: 5000n, capCents: null }, 0n) === 0n,
  );
  check(
    "a credit balance means no fee",
    lateFeeAmount({ kind: "flat", value: 5000n, capCents: null }, -100n) === 0n,
  );

  section("calendar and timezone");

  check("February 2026 has 28 days", daysInMonth({ year: 2026, month: 2 }) === 28);
  check("February 2028 has 29 days", daysInMonth({ year: 2028, month: 2 }) === 29);
  check(
    "due day is clamped to the month",
    dueDateFor({ year: 2026, month: 2 }, 28).getUTCDate() === 28,
  );

  const occ = occupiedDays(
    { year: 2026, month: 9 },
    { startsOn: D("2026-09-16"), endsOn: null },
  );
  check("mid-month move-in occupies 15 of 30 days", occ.days === 15 && occ.total === 30, `${occ.days}/${occ.total}`);
  check("...and is flagged partial", occ.partial);

  const whole = occupiedDays({ year: 2026, month: 9 }, { startsOn: D("2026-01-01"), endsOn: null });
  check("a full month is not partial", !whole.partial && whole.days === 30);

  // EST is UTC-5, so 04:30 UTC on Jan 1 is still 23:30 on Dec 31 in Pittsburgh.
  // This is exactly the boundary that makes UTC-based billing post a month early.
  const instant = new Date("2026-01-01T04:30:00Z");
  check(
    "UTC instant maps to the correct local date",
    localDateString(instant, "America/New_York") === "2025-12-31",
    localDateString(instant, "America/New_York"),
  );
  check(
    "...and to the correct local billing period",
    localPeriod(instant, "America/New_York").month === 12,
  );
  check(
    "the same instant is already January in UTC",
    localDateString(instant, "UTC") === "2026-01-01",
  );

  section("rent planning");

  const lease: LeaseSnapshot = {
    leaseId: "L1",
    status: "active",
    startsOn: D("2026-01-01"),
    endsOn: null,
    rentDueDay: 1,
    timezone: "America/New_York",
    rentPeriods: [
      { effectiveFrom: D("2026-01-01"), rentCents: 200000n },
      { effectiveFrom: D("2026-07-01"), rentCents: 210000n },
    ],
    tenants: [
      { leaseTenantId: "T1", startsOn: D("2026-01-01"), endsOn: null, shareBps: 6000, absorbsRemainder: true },
      { leaseTenantId: "T2", startsOn: D("2026-01-01"), endsOn: null, shareBps: 4000, absorbsRemainder: false },
    ],
    lateFee: { kind: "percent_of_rent", value: 5n, capCents: null, graceDays: 5, appliesToWater: false },
  };

  const sept = planRent(lease, { year: 2026, month: 9 })!;
  check("uses the rent in effect, not the original", sept.amountCents === 210000n, `${sept.amountCents}`);
  check("idempotency key is period-scoped", sept.idempotencyKey === "rent:L1:2026-09");
  check("allocations sum to the charge", sept.allocations.reduce((s, a) => s + a.amountCents, 0n) === 210000n);

  const june = planRent(lease, { year: 2026, month: 6 })!;
  check("earlier period uses the earlier rent", june.amountCents === 200000n);

  const midMonth = planRent(
    { ...lease, startsOn: D("2026-09-16") },
    { year: 2026, month: 9 },
  )!;
  check("mid-month start is prorated", midMonth.amountCents === 105000n, `${midMonth.amountCents}`);
  check("...and says so", midMonth.description.includes("prorated"));

  check(
    "no rent before the lease begins",
    planRent({ ...lease, startsOn: D("2026-10-01") }, { year: 2026, month: 9 }) === null,
  );
  check(
    "no rent after it ends",
    planRent({ ...lease, endsOn: D("2026-08-31") }, { year: 2026, month: 9 }) === null,
  );
  check(
    "draft leases are not billed",
    planRent({ ...lease, status: "draft" }, { year: 2026, month: 9 }) === null,
  );

  section("water planning");

  const water = planWater(lease, {
    amountCents: 12000n,
    serviceStart: D("2026-08-01"),
    serviceEnd: D("2026-08-31"),
    dueOn: D("2026-09-15"),
  })!;
  check("water uses the service window, not the receipt date", water.periodStart!.getUTCMonth() === 7);
  check("water allocations reconcile", water.allocations.reduce((s, a) => s + a.amountCents, 0n) === 12000n);

  const movedOut = planWater(
    {
      ...lease,
      tenants: [
        { leaseTenantId: "T1", startsOn: D("2026-01-01"), endsOn: null, shareBps: 5000, absorbsRemainder: true },
        { leaseTenantId: "T2", startsOn: D("2026-01-01"), endsOn: D("2026-08-15"), shareBps: 5000, absorbsRemainder: false },
      ],
    },
    { amountCents: 12000n, serviceStart: D("2026-08-01"), serviceEnd: D("2026-08-31"), dueOn: D("2026-09-15") },
  )!;
  const t1 = movedOut.allocations.find((a) => a.leaseTenantId === "T1")!.amountCents;
  const t2 = movedOut.allocations.find((a) => a.leaseTenantId === "T2")!.amountCents;
  check("a tenant who moved out mid-period pays less", t2 < t1, `T1 ${t1} vs T2 ${t2}`);
  check("...and the total is still exact", t1 + t2 === 12000n);

  section("late fee planning");

  const posted = [
    { id: "c1", kind: "rent" as const, amountCents: 210000n, dueOn: D("2026-09-01") },
  ];

  check(
    "no fee inside the grace period",
    planLateFee(lease, { year: 2026, month: 9 }, posted, 0n, D("2026-09-06")) === null,
  );

  const levied = planLateFee(lease, { year: 2026, month: 9 }, posted, 0n, D("2026-09-07"));
  check("fee is levied the day after grace expires", levied !== null);
  check("...at 5% of the overdue rent", levied?.amountCents === 10500n, `${levied?.amountCents}`);
  check("...with a period-scoped key", levied?.idempotencyKey === "late_fee:L1:2026-09");

  check(
    "no fee when rent was paid in full",
    planLateFee(lease, { year: 2026, month: 9 }, posted, 210000n, D("2026-09-20")) === null,
  );

  const partial = planLateFee(lease, { year: 2026, month: 9 }, posted, 200000n, D("2026-09-20"));
  check("partial payment still incurs a fee on the balance", partial?.amountCents === 500n, `${partial?.amountCents}`);

  check(
    "no fee when no rent was ever charged",
    planLateFee(lease, { year: 2026, month: 10 }, posted, 0n, D("2026-10-20")) === null,
  );

  // A fee must not be computed on top of an existing fee.
  const withFee = [
    ...posted,
    { id: "f1", kind: "late_fee" as const, amountCents: 10500n, dueOn: D("2026-09-07") },
  ];
  const notCompounded = planLateFee(lease, { year: 2026, month: 9 }, withFee, 0n, D("2026-09-20"));
  check(
    "fees do not compound on other fees",
    notCompounded?.amountCents === 10500n,
    `${notCompounded?.amountCents}`,
  );
}

// ---------------------------------------------------------------------------
async function dbChecks() {
  section("generation against the database");

  // Seeded fixtures: lease A has $2100 rent, due on the 1st, 60/40 split.
  const leaseId = "a0000000-0000-0000-0000-000000000003";
  const period = { year: 2026, month: 11 };
  const waterKey = `water:${leaseId}:2026-10-01_2026-10-31`;

  // Reset from any previous run. Posted charges cannot simply be deleted — the
  // ledger trigger blocks it — so this goes through the privileged helper.
  await teardownGeneratedCharges(leaseId, waterKey);

  const first = await generateRent(period);
  check("rent generated for the seeded lease", first.rentCreated >= 1, `created ${first.rentCreated}`);
  check("no errors", first.errors.length === 0, JSON.stringify(first.errors));

  const charge = await ownerDb().charge.findUnique({
    where: { idempotencyKey: `rent:${leaseId}:2026-11` },
    include: { allocations: true },
  });
  check("charge exists with the expected key", charge !== null);
  check("amount matches the lease rent", charge?.amountCents === 210000n, `${charge?.amountCents}`);
  check("allocated to both tenants", charge?.allocations.length === 2, `${charge?.allocations.length}`);
  check(
    "allocations reconcile to the charge",
    charge!.allocations.reduce((s, a) => s + a.amountCents, 0n) === charge!.amountCents,
  );

  const ledger = await ownerDb().ledgerEntry.findFirst({ where: { chargeId: charge!.id } });
  check("a ledger entry was posted alongside", ledger !== null);
  check("ledger entry is positive (increases what is owed)", (ledger?.amountCents ?? 0n) > 0n);

  // The critical property: running twice must not double-charge.
  const second = await generateRent(period);
  check("re-running creates nothing", second.rentCreated === 0, `created ${second.rentCreated}`);
  const count = await ownerDb().charge.count({
    where: { leaseId, chargeType: "rent", dueOn: utcDate(2026, 11, 1) },
  });
  check("exactly one rent charge exists after two runs", count === 1, `${count}`);

  section("late fees against the database");

  const early = await assessLateFees(period, new Date("2026-11-04T12:00:00Z"));
  check("no fee during the grace period", early.lateFeesCreated === 0);

  const late = await assessLateFees(period, new Date("2026-11-20T12:00:00Z"));
  check("fee levied after grace expires", late.lateFeesCreated >= 1, `created ${late.lateFeesCreated}`);

  const again = await assessLateFees(period, new Date("2026-11-21T12:00:00Z"));
  check("a second run levies nothing more", again.lateFeesCreated === 0);
  const feeCount = await ownerDb().charge.count({
    where: { leaseId, chargeType: "late_fee", idempotencyKey: `late_fee:${leaseId}:2026-11` },
  });
  check("exactly one late fee exists", feeCount === 1, `${feeCount}`);

  section("water billing against the database");

  const bill = await recordWaterBill(leaseId, {
    amountCents: 9000n,
    serviceStart: utcDate(2026, 10, 1),
    serviceEnd: utcDate(2026, 10, 31),
    dueOn: utcDate(2026, 11, 15),
    documentUrl: "https://example.test/pwsa-october.pdf",
  });
  check("water bill recorded", bill.created, bill.reason ?? "");

  const waterCharge = await ownerDb().charge.findUnique({
    where: { idempotencyKey: waterKey },
    include: { allocations: true },
  });
  check("service period stored, not the receipt date", waterCharge?.periodStart?.getUTCMonth() === 9);
  check("bill document attached", waterCharge?.documentUrl?.includes("pwsa") === true);
  check(
    "water allocations reconcile",
    waterCharge!.allocations.reduce((s, a) => s + a.amountCents, 0n) === 9000n,
  );

  const duplicate = await recordWaterBill(leaseId, {
    amountCents: 9000n,
    serviceStart: utcDate(2026, 10, 1),
    serviceEnd: utcDate(2026, 10, 31),
    dueOn: utcDate(2026, 11, 15),
  });
  check("the same service period cannot be billed twice", !duplicate.created && duplicate.reason === "duplicate");

  section("generated charges respect RLS");

  const tam = "33333333-3333-3333-3333-333333333333";
  const bob = "22222222-2222-2222-2222-222222222222";

  const tamSees = await asUser(tam, (tx) =>
    tx.charge.findMany({ where: { leaseId }, select: { id: true } }),
  );
  check("the tenant sees their own generated charges", tamSees.length > 0, `${tamSees.length}`);

  const bobSees = await asUser(bob, (tx) =>
    tx.charge.findMany({ where: { leaseId }, select: { id: true } }),
  );
  check("the other landlord sees none of them", bobSees.length === 0, `${bobSees.length}`);

  const tamAllocations = await asUser(tam, (tx) => tx.chargeAllocation.findMany());
  check("the tenant sees their allocations", tamAllocations.length > 0);

  section("the ledger refuses to let generated charges be deleted");

  let deleteRejected = false;
  try {
    await ownerDb().charge.deleteMany({ where: { idempotencyKey: waterKey } });
  } catch (error) {
    deleteRejected = /append-only/.test(String(error));
  }
  check(
    "deleting a posted charge is blocked by the ledger trigger",
    deleteRejected,
    "charge deletion nulls ledger_entry.charge_id, which is an UPDATE",
  );

  // Teardown therefore needs privileged help. In PRODUCTION a charge posted in
  // error is corrected with an offsetting reversal entry, never a delete —
  // this trigger is exactly what forces that discipline. Disabling it is
  // acceptable only here, as the owner role, to reset fixtures.
  await teardownGeneratedCharges(leaseId, waterKey);
}

/**
 * Test-only fixture reset.
 *
 * The append-only trigger makes generated charges permanent, which is the point
 * — production corrections are offsetting reversal entries, not deletions. To
 * reset fixtures we briefly disable the trigger as the owner role. Nothing
 * outside this suite should ever do this.
 */
async function teardownGeneratedCharges(leaseId: string, waterKey: string) {
  await ownerDb().$executeRawUnsafe(
    `alter table ledger_entry disable trigger ledger_entry_no_mutation`,
  );
  try {
    const doomed = await ownerDb().charge.findMany({
      where: {
        leaseId,
        OR: [{ dueOn: { gte: utcDate(2026, 11, 1) } }, { idempotencyKey: waterKey }],
      },
      select: { id: true },
    });
    const ids = doomed.map((c) => c.id);
    await ownerDb().ledgerEntry.deleteMany({ where: { chargeId: { in: ids } } });
    await ownerDb().charge.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await ownerDb().$executeRawUnsafe(
      `alter table ledger_entry enable trigger ledger_entry_no_mutation`,
    );
  }
}

async function main() {
  pureChecks();
  await dbChecks();

  console.log(
    failures === 0
      ? `\nAll ${checks} billing checks passed.\n`
      : `\n${failures} of ${checks} billing checks FAILED.\n`,
  );
  await ownerDb().$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
