/**
 * Auth behaviour suite. Run with:  npm run auth:check
 *
 * Weighted toward the properties that matter if they are wrong — enumeration,
 * replay, brute force, cross-org authorization, and whether a session actually
 * composes with row level security. Cleans up after itself so it is re-runnable.
 */
import { asUser, ownerDb } from "./db.js";
import {
  acceptInvitation,
  authCodePolicy,
  createInvitation,
  registerLandlord,
  requestLoginCode,
  revokeAllSessions,
  revokeSession,
  validateSession,
  verifyLoginCode,
} from "./auth/index.js";

const SUFFIX = "@authcheck.test";
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

/** Captures the code that would have been emailed. */
function collector() {
  const codes: string[] = [];
  return {
    codes,
    deliver: ({ code }: { code: string }) => {
      codes.push(code);
    },
    latest: () => codes[codes.length - 1]!,
  };
}

async function cleanup() {
  const users = await ownerDb().appUser.findMany({
    where: { email: { endsWith: SUFFIX } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  const orgs = await ownerDb().orgMember.findMany({
    where: { userId: { in: ids } },
    select: { orgId: true },
  });
  await ownerDb().authCode.deleteMany({ where: { email: { endsWith: SUFFIX } } });
  await ownerDb().invitation.deleteMany({ where: { email: { endsWith: SUFFIX } } });
  await ownerDb().appUser.deleteMany({ where: { id: { in: ids } } });
  await ownerDb().org.deleteMany({ where: { id: { in: orgs.map((o) => o.orgId) } } });
}

async function main() {
  await cleanup();

  // ---------------------------------------------------------------------
  section("landlord self-registration");

  const alice = await registerLandlord({
    email: `alice${SUFFIX}`,
    orgName: "Alice Check LLC",
    displayName: "Alice",
  });
  check("registerLandlord succeeds", alice.ok);
  if (!alice.ok) throw new Error("cannot continue");

  const membership = await ownerDb().orgMember.findFirst({
    where: { userId: alice.userId },
    select: { role: true, orgId: true },
  });
  check("creates an owner membership atomically", membership?.role === "owner");
  check("returns a usable session", (await validateSession(alice.session.token))?.userId === alice.userId);

  const dupe = await registerLandlord({ email: `ALICE${SUFFIX}`, orgName: "Impostor LLC" });
  check("duplicate email rejected, case-insensitively", !dupe.ok);

  // ---------------------------------------------------------------------
  section("login codes: no account enumeration");

  const unknown = collector();
  const unknownResult = await requestLoginCode({
    email: `nobody${SUFFIX}`,
    ip: "203.0.113.10",
    deliver: unknown.deliver,
  });
  check("unknown address still returns accepted", unknownResult.accepted === true);
  check("...but no code is issued", unknown.codes.length === 0);
  check(
    "...and no row is written",
    (await ownerDb().authCode.count({ where: { email: `nobody${SUFFIX}` } })) === 0,
  );

  const known = collector();
  await requestLoginCode({ email: `alice${SUFFIX}`, ip: "203.0.113.11", deliver: known.deliver });
  check("known address issues exactly one code", known.codes.length === 1);
  check("code is 6 digits", /^\d{6}$/.test(known.latest()));

  const stored = await ownerDb().authCode.findFirst({ where: { email: `alice${SUFFIX}` } });
  check("plaintext code is never stored", stored?.codeHash !== known.latest());

  // ---------------------------------------------------------------------
  section("login codes: brute force and replay");

  for (let i = 0; i < authCodePolicy.MAX_VERIFY_ATTEMPTS; i++) {
    await verifyLoginCode({ email: `alice${SUFFIX}`, code: "000000" });
  }
  const lockedOut = await verifyLoginCode({ email: `alice${SUFFIX}`, code: known.latest() });
  check(
    "correct code rejected after attempt limit",
    !lockedOut.ok && lockedOut.reason === "too_many_attempts",
    !lockedOut.ok ? lockedOut.reason : "accepted!",
  );

  const fresh = collector();
  await requestLoginCode({ email: `alice${SUFFIX}`, ip: "203.0.113.12", deliver: fresh.deliver });
  const wrong = await verifyLoginCode({ email: `alice${SUFFIX}`, code: "999999" });
  check(
    "wrong code gives a generic reason",
    !wrong.ok && wrong.reason === "invalid_or_expired",
  );

  const good = await verifyLoginCode({ email: `alice${SUFFIX}`, code: fresh.latest() });
  check("correct code returns a session", good.ok);

  const replay = await verifyLoginCode({ email: `alice${SUFFIX}`, code: fresh.latest() });
  check("the same code cannot be used twice", !replay.ok);

  // Reissue, then supersede it, and confirm the older one is dead.
  const first = collector();
  await requestLoginCode({ email: `alice${SUFFIX}`, ip: "203.0.113.13", deliver: first.deliver });
  const second = collector();
  await requestLoginCode({ email: `alice${SUFFIX}`, ip: "203.0.113.14", deliver: second.deliver });
  const superseded = await verifyLoginCode({ email: `alice${SUFFIX}`, code: first.latest() });
  check("resending invalidates the previous code", !superseded.ok);

  const current = await verifyLoginCode({ email: `alice${SUFFIX}`, code: second.latest() });
  check("the newest code still works", current.ok);

  // Expiry
  const expiring = collector();
  await requestLoginCode({ email: `alice${SUFFIX}`, ip: "203.0.113.15", deliver: expiring.deliver });
  await ownerDb().authCode.updateMany({
    where: { email: `alice${SUFFIX}`, consumedAt: null },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expired = await verifyLoginCode({ email: `alice${SUFFIX}`, code: expiring.latest() });
  check("expired code is rejected", !expired.ok);

  // ---------------------------------------------------------------------
  section("login codes: rate limiting");

  await ownerDb().authCode.deleteMany({ where: { email: `alice${SUFFIX}` } });
  let limited = false;
  for (let i = 0; i <= authCodePolicy.MAX_REQUESTS_PER_EMAIL_PER_HOUR; i++) {
    const r = await requestLoginCode({ email: `alice${SUFFIX}`, ip: "203.0.113.20" });
    if (!r.accepted) limited = true;
  }
  check("per-address rate limit engages", limited);

  // ---------------------------------------------------------------------
  section("sessions");

  const s = await ownerDb().session.findFirst({ where: { userId: alice.userId } });
  check("only the token hash is persisted", s !== null && s.tokenHash.length === 64);
  check("garbage token does not validate", (await validateSession("not-a-real-token")) === null);
  check("empty token does not validate", (await validateSession("")) === null);

  const live = await registerLandlord({ email: `bob${SUFFIX}`, orgName: "Bob Check LLC" });
  if (!live.ok) throw new Error("cannot continue");
  check("new session validates", (await validateSession(live.session.token)) !== null);
  await revokeSession(live.session.token);
  check("revoked session stops validating", (await validateSession(live.session.token)) === null);

  const a = await ownerDb().session.count({ where: { userId: alice.userId, revokedAt: null } });
  await revokeAllSessions(alice.userId);
  const b = await ownerDb().session.count({ where: { userId: alice.userId, revokedAt: null } });
  check("revokeAllSessions clears every live session", a > 0 && b === 0, `${a} -> ${b}`);

  // ---------------------------------------------------------------------
  section("invitations and role separation");

  // Alice needs a lease to invite a tenant to.
  const property = await ownerDb().property.create({
    data: {
      orgId: membership!.orgId,
      name: "Check Property",
      line1: "1 Test St",
      city: "Pittsburgh",
      region: "PA",
      postalCode: "15224",
    },
  });
  const unit = await ownerDb().unit.create({
    data: { propertyId: property.id, label: "1A" },
  });
  const lease = await ownerDb().lease.create({
    data: { unitId: unit.id, status: "active", startsOn: new Date("2026-01-01") },
  });

  const badTarget = await createInvitation({
    inviterUserId: alice.userId,
    email: `x${SUFFIX}`,
    orgId: membership!.orgId,
    leaseId: lease.id,
    orgRole: "staff",
  });
  check("invitation targeting both org and lease is refused", !badTarget.ok);

  const crossOrg = await createInvitation({
    inviterUserId: live.userId, // Bob
    email: `intruder${SUFFIX}`,
    leaseId: lease.id, // Alice's lease
  });
  check(
    "landlord cannot invite to another org's lease",
    !crossOrg.ok && crossOrg.reason === "not_authorized",
  );

  const invite = await createInvitation({
    inviterUserId: alice.userId,
    email: `tam${SUFFIX}`,
    leaseId: lease.id,
  });
  check("landlord can invite a tenant to their own lease", invite.ok);
  if (!invite.ok) throw new Error("cannot continue");

  const storedInvite = await ownerDb().invitation.findUnique({
    where: { id: invite.invitationId },
    select: { tokenHash: true },
  });
  check("invitation token is stored hashed", storedInvite?.tokenHash !== invite.token);

  const accepted = await acceptInvitation({ token: invite.token, displayName: "Tam" });
  check("accepting creates the tenant account", accepted.ok);
  if (!accepted.ok) throw new Error("cannot continue");
  check("accepted as a tenant, not a landlord", accepted.role === "tenant");

  const tenantOrgs = await ownerDb().orgMember.count({ where: { userId: accepted.userId } });
  check("tenant holds no org membership", tenantOrgs === 0);

  const reuse = await acceptInvitation({ token: invite.token });
  check("invitation token cannot be redeemed twice", !reuse.ok);

  const tenantInvite = await createInvitation({
    inviterUserId: accepted.userId,
    email: `friend${SUFFIX}`,
    leaseId: lease.id,
  });
  check(
    "a tenant cannot invite anyone",
    !tenantInvite.ok && tenantInvite.reason === "not_authorized",
  );

  // ---------------------------------------------------------------------
  section("auth composes with row level security");

  const tenantLeases = await asUser(accepted.userId, (tx) => tx.lease.findMany());
  check("invited tenant sees exactly their lease", tenantLeases.length === 1);
  check("...and it is the right one", tenantLeases[0]?.id === lease.id);

  const bobLeases = await asUser(live.userId, (tx) => tx.lease.findMany());
  check("other landlord sees none of it", bobLeases.length === 0, `got ${bobLeases.length}`);

  const aliceLeases = await asUser(alice.userId, (tx) => tx.lease.findMany());
  check("inviting landlord sees the lease", aliceLeases.some((l) => l.id === lease.id));

  // ---------------------------------------------------------------------
  await ownerDb().lease.deleteMany({ where: { id: lease.id } });
  await ownerDb().unit.deleteMany({ where: { id: unit.id } });
  await ownerDb().property.deleteMany({ where: { id: property.id } });
  await cleanup();

  console.log(
    failures === 0
      ? `\nAll ${checks} auth checks passed.\n`
      : `\n${failures} of ${checks} auth checks FAILED.\n`,
  );
  await ownerDb().$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
