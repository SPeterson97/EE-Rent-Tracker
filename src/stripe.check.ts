/**
 * Stripe suite. Run with:  npm run stripe:check
 *
 * No API keys and no network. The gateway is faked; webhook signatures are real
 * HMACs generated with a test secret, so signature verification is genuinely
 * exercised rather than stubbed out.
 *
 * Weighted toward the ACH lifecycle, because the dangerous part is not taking a
 * payment — it is a payment that settles days later and can reverse weeks after
 * that.
 */
import { createHmac, randomUUID } from "node:crypto";
import { ownerDb } from "./db.js";
import { CapturingMailer, setMailer } from "./email/mailer.js";
import { setGateway } from "./stripe/gateway.js";
import { FakeStripeGateway } from "./stripe/gateway.fake.js";
import {
  ensureCustomer,
  initiatePayment,
  startConnectOnboarding,
  syncConnectStatus,
} from "./stripe/payments.js";
import { receiveWebhook } from "./stripe/webhooks.js";

const WEBHOOK_SECRET = "whsec_test_secret_for_the_suite";
const fake = new FakeStripeGateway();
const mail = new CapturingMailer();

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

/** Builds a correctly signed webhook payload, the way Stripe does. */
function signedEvent(type: string, object: unknown, account?: string) {
  const event = {
    id: `evt_${randomUUID().slice(0, 16)}`,
    object: "event",
    type,
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object },
    ...(account ? { account } : {}),
  };
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return { rawBody, signature: `t=${timestamp},v1=${signature}`, eventId: event.id };
}

const LEASE = "a0000000-0000-0000-0000-000000000003";
const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TAM = "33333333-3333-3333-3333-333333333333";

async function balance(): Promise<bigint> {
  const row = await ownerDb().leaseBalance.findFirst({ where: { leaseId: LEASE } });
  return row?.balanceCents ?? 0n;
}

async function resetPayments() {
  await ownerDb().$executeRawUnsafe(
    `alter table ledger_entry disable trigger ledger_entry_no_mutation`,
  );
  try {
    await ownerDb().ledgerEntry.deleteMany({ where: { paymentId: { not: null } } });
    await ownerDb().payment.deleteMany({ where: { leaseId: LEASE } });
  } finally {
    await ownerDb().$executeRawUnsafe(
      `alter table ledger_entry enable trigger ledger_entry_no_mutation`,
    );
  }
  await ownerDb().stripeEvent.deleteMany({});
  await ownerDb().org.update({
    where: { id: ORG },
    data: { stripeConnectedAccountId: null, connectStatus: "not_started", connectPayoutsEnabled: false },
  });
}

async function main() {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder_for_signature_verification";
  setGateway(fake);
  setMailer(mail);
  await resetPayments();

  // ---------------------------------------------------------------------
  section("Connect onboarding");

  const link = await startConnectOnboarding({
    orgId: ORG,
    email: "alice@landlord.test",
    refreshUrl: "https://app.test/connect/refresh",
    returnUrl: "https://app.test/connect/return",
  });
  check("onboarding link generated in-app", link.url.startsWith("https://connect.stripe.test/"));
  check("connected account id persisted", link.accountId.startsWith("acct_"));

  const pending = await ownerDb().org.findUnique({ where: { id: ORG } });
  check("org marked pending, not active", pending?.connectStatus === "pending");
  check("payouts not yet enabled", pending?.connectPayoutsEnabled === false);

  const again = await startConnectOnboarding({
    orgId: ORG,
    email: "alice@landlord.test",
    refreshUrl: "https://app.test/connect/refresh",
    returnUrl: "https://app.test/connect/return",
  });
  check("resuming reuses the same account", again.accountId === link.accountId);

  // ---------------------------------------------------------------------
  section("payment refused before onboarding completes");

  fake.payoutsEnabled = false;
  await syncConnectStatus(ORG);

  const tooEarly = await initiatePayment({
    leaseId: LEASE,
    payerUserId: TAM,
    amountCents: 126000n,
    paymentMethodId: "a0000000-0000-0000-0000-00000000000a",
    idempotencyKey: `test-early-${randomUUID()}`,
  });
  check(
    "refuses to collect when the landlord cannot be paid out",
    !tooEarly.ok && tooEarly.reason === "payouts_disabled",
    tooEarly.ok ? "accepted!" : tooEarly.reason,
  );

  fake.payoutsEnabled = true;
  fake.completeOnboarding(link.accountId);
  const synced = await syncConnectStatus(ORG);
  check("status becomes active after onboarding", synced.status === "active");

  // ---------------------------------------------------------------------
  section("ACH payment lifecycle");

  const openingBalance = await balance();
  const idem = `rent-nov-${randomUUID()}`;

  const started = await initiatePayment({
    leaseId: LEASE,
    payerUserId: TAM,
    amountCents: 126000n,
    paymentMethodId: "a0000000-0000-0000-0000-00000000000a",
    idempotencyKey: idem,
  });
  check("payment initiated", started.ok, started.ok ? "" : started.reason);
  if (!started.ok) throw new Error("cannot continue");

  const created = await ownerDb().payment.findUnique({ where: { id: started.paymentId } });
  check("stored as processing, not succeeded", created?.status === "processing", created?.status);
  check("intent id recorded", created?.stripePaymentIntentId?.startsWith("pi_") === true);
  check(
    "THE LEDGER IS UNTOUCHED until settlement",
    (await balance()) === openingBalance,
    `${await balance()} vs ${openingBalance}`,
  );

  // Replay the same request: must not create a second charge.
  const replayed = await initiatePayment({
    leaseId: LEASE,
    payerUserId: TAM,
    amountCents: 126000n,
    paymentMethodId: "a0000000-0000-0000-0000-00000000000a",
    idempotencyKey: idem,
  });
  check(
    "replaying the request returns the ORIGINAL payment, not a second one",
    replayed.ok && replayed.paymentId === started.paymentId && replayed.duplicate === true,
    replayed.ok ? `${replayed.paymentId}` : replayed.reason,
  );
  const paymentCount = await ownerDb().payment.count({ where: { idempotencyKey: idem } });
  check("only one payment row exists for the key", paymentCount === 1, `${paymentCount}`);

  const intentId = created!.stripePaymentIntentId!;

  // --- settlement, days later ---
  const success = signedEvent("payment_intent.succeeded", {
    id: intentId,
    object: "payment_intent",
    amount: 126000,
    metadata: { paymentId: started.paymentId, leaseId: LEASE, payerUserId: TAM },
  });
  const settled = await receiveWebhook({ rawBody: success.rawBody, signature: success.signature });
  check("settlement webhook accepted", settled.ok);

  const afterSettle = await ownerDb().payment.findUnique({ where: { id: started.paymentId } });
  check("payment marked succeeded", afterSettle?.status === "succeeded");
  check("settledAt recorded", afterSettle?.settledAt !== null);
  check(
    "ledger credited exactly once",
    (await balance()) === openingBalance - 126000n,
    `${await balance()}`,
  );

  const entries = await ownerDb().ledgerEntry.count({
    where: { paymentId: started.paymentId, entryType: "payment" },
  });
  check("exactly one payment entry", entries === 1, `${entries}`);

  // --- Stripe redelivers the same event ---
  const redelivered = await receiveWebhook({
    rawBody: success.rawBody,
    signature: success.signature,
  });
  check(
    "redelivered event is deduplicated",
    redelivered.ok && redelivered.duplicate === true,
  );
  check(
    "balance unchanged after redelivery",
    (await balance()) === openingBalance - 126000n,
  );

  // --- a DIFFERENT event id carrying the same settlement ---
  const dupSuccess = signedEvent("payment_intent.succeeded", {
    id: intentId,
    object: "payment_intent",
    amount: 126000,
    metadata: { paymentId: started.paymentId },
  });
  await receiveWebhook({ rawBody: dupSuccess.rawBody, signature: dupSuccess.signature });
  const entriesAfter = await ownerDb().ledgerEntry.count({
    where: { paymentId: started.paymentId, entryType: "payment" },
  });
  check(
    "a second settlement event still credits only once",
    entriesAfter === 1,
    `${entriesAfter} entries`,
  );

  // ---------------------------------------------------------------------
  section("ACH reversal after settlement");

  const beforeReversal = await balance();
  const dispute = signedEvent("charge.dispute.created", {
    id: `dp_${randomUUID().slice(0, 10)}`,
    object: "dispute",
    payment_intent: intentId,
    reason: "unauthorized",
  });
  await receiveWebhook({ rawBody: dispute.rawBody, signature: dispute.signature });

  const reversedPayment = await ownerDb().payment.findUnique({ where: { id: started.paymentId } });
  check("payment marked reversed", reversedPayment?.status === "reversed");
  check(
    "the debt comes back",
    (await balance()) === beforeReversal + 126000n,
    `${beforeReversal} -> ${await balance()}`,
  );

  const reversal = await ownerDb().ledgerEntry.findFirst({
    where: { paymentId: started.paymentId, entryType: "reversal" },
  });
  check("reversal points at the original entry", reversal?.reversesEntryId !== null);
  check("original credit is still on record", entriesAfter === 1);

  const disputeAgain = signedEvent("charge.dispute.created", {
    id: `dp_${randomUUID().slice(0, 10)}`,
    object: "dispute",
    payment_intent: intentId,
  });
  await receiveWebhook({ rawBody: disputeAgain.rawBody, signature: disputeAgain.signature });
  const reversals = await ownerDb().ledgerEntry.count({
    where: { paymentId: started.paymentId, entryType: "reversal" },
  });
  check("a second reversal event does not double-reverse", reversals === 1, `${reversals}`);

  // ---------------------------------------------------------------------
  section("webhook security");

  const forged = signedEvent("payment_intent.succeeded", {
    id: intentId,
    object: "payment_intent",
    amount: 126000,
  });
  const badSig = await receiveWebhook({ rawBody: forged.rawBody, signature: "t=1,v1=deadbeef" });
  check("invalid signature is rejected", !badSig.ok && badSig.reason === "bad_signature");

  const noSig = await receiveWebhook({ rawBody: forged.rawBody, signature: null });
  check("missing signature is rejected", !noSig.ok);

  // Raise the amount after signing — the exact attack the signature prevents.
  const tamperedBody = forged.rawBody.replace('"amount":126000', '"amount":999900');
  check("tamper actually changed the payload", tamperedBody !== forged.rawBody);
  const tampered = await receiveWebhook({
    rawBody: tamperedBody,
    signature: forged.signature,
  });
  check("tampered body is rejected", !tampered.ok && tampered.reason === "bad_signature");

  const stored = await ownerDb().stripeEvent.count();
  check("only verified events were persisted", stored > 0, `${stored}`);

  // ---------------------------------------------------------------------
  section("failure before settlement");

  const failIdem = `fail-${randomUUID()}`;
  const failing = await initiatePayment({
    leaseId: LEASE,
    payerUserId: TAM,
    amountCents: 50000n,
    paymentMethodId: "a0000000-0000-0000-0000-00000000000a",
    idempotencyKey: failIdem,
  });
  if (!failing.ok) throw new Error("cannot continue");

  const failingRow = await ownerDb().payment.findUnique({ where: { id: failing.paymentId } });
  const balanceBeforeFailure = await balance();

  const failed = signedEvent("payment_intent.payment_failed", {
    id: failingRow!.stripePaymentIntentId,
    object: "payment_intent",
    metadata: { paymentId: failing.paymentId },
    last_payment_error: { code: "insufficient_funds", message: "Insufficient funds." },
  });
  await receiveWebhook({ rawBody: failed.rawBody, signature: failed.signature });

  const afterFailure = await ownerDb().payment.findUnique({ where: { id: failing.paymentId } });
  check("failed payment recorded", afterFailure?.status === "failed");
  check("failure code captured", afterFailure?.failureCode === "insufficient_funds");
  check(
    "no ledger movement for a payment that never settled",
    (await balance()) === balanceBeforeFailure,
  );

  // ---------------------------------------------------------------------
  section("unknown events and account updates");

  const unknown = signedEvent("invoice.created", { id: "in_test" });
  const unknownResult = await receiveWebhook({
    rawBody: unknown.rawBody,
    signature: unknown.signature,
  });
  check("unknown event types are accepted but unhandled", unknownResult.ok && !(unknownResult as any).handled);

  const accountEvent = signedEvent("account.updated", {
    id: link.accountId,
    object: "account",
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: true,
  });
  await receiveWebhook({ rawBody: accountEvent.rawBody, signature: accountEvent.signature });
  const restricted = await ownerDb().org.findUnique({ where: { id: ORG } });
  check(
    "account.updated can restrict a landlord",
    restricted?.connectStatus === "restricted",
    restricted?.connectStatus,
  );
  check("payouts disabled follows", restricted?.connectPayoutsEnabled === false);

  await resetPayments();

  console.log(
    failures === 0
      ? `\nAll ${checks} Stripe checks passed.\n`
      : `\n${failures} of ${checks} Stripe checks FAILED.\n`,
  );
  await ownerDb().$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await resetPayments().catch(() => {});
  process.exit(1);
});
