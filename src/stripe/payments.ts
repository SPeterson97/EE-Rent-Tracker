import { ownerDb } from "../db.js";
import { gateway } from "./gateway.js";

/**
 * Connect onboarding, payment instruments, and initiating payments.
 *
 * Uses ownerDb throughout: these run either as background reconciliation or on
 * behalf of a user whose authorization has already been checked at the HTTP
 * layer. Nothing here re-derives permissions.
 *
 * IMPORTANT: initiating a payment does NOT credit the ledger. ACH takes days to
 * settle and can fail after appearing to succeed, so the ledger is only touched
 * when Stripe confirms settlement — see webhooks.ts.
 */

export interface OnboardingLink {
  url: string;
  expiresAt: Date;
  accountId: string;
}

/**
 * Starts or resumes Connect onboarding for a landlord org.
 *
 * The account is created once and reused; links are short-lived and must be
 * regenerated each time the landlord returns to finish.
 */
export async function startConnectOnboarding(input: {
  orgId: string;
  email: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<OnboardingLink> {
  const org = await ownerDb().org.findUnique({
    where: { id: input.orgId },
    select: { id: true, name: true, stripeConnectedAccountId: true },
  });
  if (!org) throw new Error(`org ${input.orgId} not found`);

  let accountId = org.stripeConnectedAccountId;

  if (!accountId) {
    const account = await gateway().createConnectedAccount({
      email: input.email,
      orgName: org.name,
    });
    accountId = account.id;
    await ownerDb().org.update({
      where: { id: org.id },
      data: { stripeConnectedAccountId: accountId, connectStatus: "pending" },
    });
  }

  const link = await gateway().createOnboardingLink({
    accountId,
    refreshUrl: input.refreshUrl,
    returnUrl: input.returnUrl,
  });

  return { ...link, accountId };
}

/**
 * Pulls the current capability state from Stripe.
 *
 * Called on return from onboarding and from the `account.updated` webhook.
 * Onboarding can also complete asynchronously — Stripe may re-verify days later
 * — so polling on return alone is not sufficient.
 */
export async function syncConnectStatus(orgId: string): Promise<{
  status: "not_started" | "pending" | "active" | "restricted";
  payoutsEnabled: boolean;
}> {
  const org = await ownerDb().org.findUnique({
    where: { id: orgId },
    select: { stripeConnectedAccountId: true },
  });
  if (!org?.stripeConnectedAccountId) {
    return { status: "not_started", payoutsEnabled: false };
  }

  const account = await gateway().retrieveAccount(org.stripeConnectedAccountId);

  const status = account.chargesEnabled && account.payoutsEnabled
    ? "active"
    : account.detailsSubmitted
      ? "restricted"
      : "pending";

  await ownerDb().org.update({
    where: { id: orgId },
    data: { connectStatus: status, connectPayoutsEnabled: account.payoutsEnabled },
  });

  return { status, payoutsEnabled: account.payoutsEnabled };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Finds or creates the Stripe customer for a user. */
export async function ensureCustomer(userId: string): Promise<string> {
  const existing = await ownerDb().stripeCustomer.findUnique({
    where: { userId },
    select: { stripeCustomerId: true },
  });
  if (existing) return existing.stripeCustomerId;

  const user = await ownerDb().appUser.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new Error(`user ${userId} not found`);

  const customer = await gateway().createCustomer({ email: user.email, userId });

  await ownerDb().stripeCustomer.create({
    data: { userId, stripeCustomerId: customer.id },
  });
  return customer.id;
}

/** Client secret for the bank-account collection flow. */
export async function startBankSetup(userId: string): Promise<{ clientSecret: string | null }> {
  const customerId = await ensureCustomer(userId);
  const intent = await gateway().createBankSetupIntent({ customerId });
  return { clientSecret: intent.clientSecret };
}

export type InitiatePaymentResult =
  | { ok: true; paymentId: string; status: string; duplicate?: boolean }
  | {
      ok: false;
      reason: "no_connected_account" | "payouts_disabled" | "no_payment_method" | "not_on_lease";
    };

/**
 * Starts an ACH debit for a tenant against their lease.
 *
 * Refuses when the landlord cannot receive money yet — taking a tenant's cash
 * into an account that cannot pay out is far worse than declining up front.
 */
export async function initiatePayment(input: {
  leaseId: string;
  payerUserId: string;
  amountCents: bigint;
  paymentMethodId: string;
  /** Caller-supplied so a retried request cannot create a second charge. */
  idempotencyKey: string;
}): Promise<InitiatePaymentResult> {
  const membership = await ownerDb().leaseTenant.findUnique({
    where: { leaseId_userId: { leaseId: input.leaseId, userId: input.payerUserId } },
    select: { id: true },
  });
  if (!membership) return { ok: false, reason: "not_on_lease" };

  const lease = await ownerDb().lease.findUnique({
    where: { id: input.leaseId },
    select: { unit: { select: { property: { select: { org: true } } } } },
  });
  const org = lease?.unit.property.org;
  if (!org?.stripeConnectedAccountId) return { ok: false, reason: "no_connected_account" };
  if (!org.connectPayoutsEnabled) return { ok: false, reason: "payouts_disabled" };

  const method = await ownerDb().paymentMethod.findFirst({
    where: { id: input.paymentMethodId, userId: input.payerUserId, detachedAt: null },
    select: { stripePaymentMethodId: true },
  });
  if (!method) return { ok: false, reason: "no_payment_method" };

  // True idempotency: a retried request returns the ORIGINAL payment rather
  // than erroring. Clients retry on timeouts, and a 500 here would push the
  // tenant to press pay again — against a debit that may already be in flight.
  const prior = await ownerDb().payment.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, status: true },
  });
  if (prior) {
    return { ok: true, paymentId: prior.id, status: prior.status, duplicate: true };
  }

  const customerId = await ensureCustomer(input.payerUserId);

  // The local row is created BEFORE calling Stripe. If the process dies
  // mid-call, a pending payment with no intent is recoverable by reconciling
  // against Stripe; an intent with no local row is an orphaned charge against
  // a tenant with no record of why.
  let payment: { id: string };
  try {
    payment = await ownerDb().payment.create({
      data: {
        leaseId: input.leaseId,
        payerUserId: input.payerUserId,
        amountCents: input.amountCents,
        channel: "ach",
        status: "pending",
        paymentMethodId: input.paymentMethodId,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true },
    });
  } catch (error) {
    // Two requests raced past the check above; the constraint is the arbiter.
    if (isUniqueViolation(error)) {
      const winner = await ownerDb().payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, status: true },
      });
      if (winner) {
        return { ok: true, paymentId: winner.id, status: winner.status, duplicate: true };
      }
    }
    throw error;
  }

  const intent = await gateway().createPaymentIntent({
    amountCents: input.amountCents,
    customerId,
    paymentMethodId: method.stripePaymentMethodId,
    destinationAccountId: org.stripeConnectedAccountId,
    idempotencyKey: input.idempotencyKey,
    metadata: {
      paymentId: payment.id,
      leaseId: input.leaseId,
      payerUserId: input.payerUserId,
    },
  });

  await ownerDb().payment.update({
    where: { id: payment.id },
    data: {
      stripePaymentIntentId: intent.id,
      // Always `processing`, even if Stripe reports success immediately. The
      // webhook is the single source of truth for settlement, and routing every
      // payment through the same path means there is one place that credits the
      // ledger rather than two that must agree.
      status: "processing",
    },
  });

  return { ok: true, paymentId: payment.id, status: intent.status };
}
