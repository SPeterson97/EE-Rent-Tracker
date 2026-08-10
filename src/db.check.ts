/**
 * Proves the data-access layer actually enforces isolation, rather than
 * appearing to. Run against the seeded dev database:  npm run db:check
 *
 * The connection-leak test is the one that matters: it is the failure mode a
 * unit test with a single connection would never surface.
 */
import { appDb, asUser, formatCents, ownerDb } from "./db.js";

const ALICE = "11111111-1111-1111-1111-111111111111"; // landlord, org A
const BOB = "22222222-2222-2222-2222-222222222222"; // landlord, org B
const TAM = "33333333-3333-3333-3333-333333333333"; // tenant on lease A

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log("\n=== asUser scopes queries to the acting user ===");

  const aliceLeases = await asUser(ALICE, (tx) => tx.lease.findMany());
  const bobLeases = await asUser(BOB, (tx) => tx.lease.findMany());
  const tamLeases = await asUser(TAM, (tx) => tx.lease.findMany());

  check("Alice sees exactly 1 lease", aliceLeases.length === 1, `got ${aliceLeases.length}`);
  check("Bob sees exactly 1 lease", bobLeases.length === 1, `got ${bobLeases.length}`);
  check("Tam sees exactly 1 lease", tamLeases.length === 1, `got ${tamLeases.length}`);
  check(
    "Alice and Bob see DIFFERENT leases",
    aliceLeases[0]?.id !== bobLeases[0]?.id,
  );

  console.log("\n=== the identity does not leak across pooled connections ===");
  // Interleaved concurrent queries on a pool. If set_config were session-scoped
  // instead of transaction-scoped, these would contaminate each other.
  const interleaved = await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const actor = i % 2 === 0 ? ALICE : BOB;
      return asUser(actor, async (tx) => ({
        actor,
        leaseIds: (await tx.lease.findMany({ select: { id: true } })).map((l) => l.id),
      }));
    }),
  );
  const aliceLeaseId = aliceLeases[0]!.id;
  const bobLeaseId = bobLeases[0]!.id;
  const contaminated = interleaved.filter(({ actor, leaseIds }) => {
    const expected = actor === ALICE ? aliceLeaseId : bobLeaseId;
    return leaseIds.length !== 1 || leaseIds[0] !== expected;
  });
  check(
    "12 interleaved concurrent requests stayed isolated",
    contaminated.length === 0,
    `${contaminated.length} contaminated`,
  );

  console.log("\n=== no identity set means no data (fails closed) ===");
  const leaked = await appDb().lease.findMany();
  check("querying appDb directly returns 0 rows", leaked.length === 0, `got ${leaked.length}`);

  console.log("\n=== the owner client bypasses RLS, as designed ===");
  const allLeases = await ownerDb().lease.findMany();
  check("ownerDb sees all 2 leases", allLeases.length === 2, `got ${allLeases.length}`);

  console.log("\n=== the append-only ledger rejects Prisma writes too ===");
  const entry = await ownerDb().ledgerEntry.findFirst();
  let rejected = false;
  try {
    await ownerDb().ledgerEntry.update({
      where: { id: entry!.id },
      data: { memo: "tampered" },
    });
  } catch {
    rejected = true;
  }
  check("ledgerEntry.update() was rejected by the trigger", rejected);

  console.log("\n=== BigInt money helpers ===");
  const balances = await asUser(ALICE, (tx) => tx.leaseBalance.findMany());
  const balance = balances[0]!.balanceCents;
  check("balance is a BigInt", typeof balance === "bigint", `${balance}`);
  check("formatCents renders correctly", formatCents(balance) === "$840.00", formatCents(balance));
  check(
    "JSON.stringify on raw BigInt still throws (why the helper exists)",
    (() => {
      try {
        JSON.stringify({ balance });
        return false;
      } catch {
        return true;
      }
    })(),
  );

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) FAILED.\n`,
  );
  await Promise.all([appDb().$disconnect(), ownerDb().$disconnect()]);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
