import type { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { alertJobFailure } from "../alerts.js";
import { ownerDb } from "../db.js";
import { stripeClient } from "./gateway.js";

/**
 * Webhook ingestion.
 *
 * Webhooks — not API responses — are the source of truth for payment state.
 * ACH settles over days and can reverse weeks later, so the response to
 * `createPaymentIntent` says almost nothing about whether money arrived.
 *
 * Every handler is idempotent. Stripe redelivers on any non-2xx, delivers out
 * of order, and can deliver the same event twice even on success.
 */

export type WebhookResult =
  | { ok: true; eventId: string; handled: boolean; duplicate?: boolean }
  | { ok: false; reason: "bad_signature" | "not_configured" };

/**
 * Verifies the signature and records the event.
 *
 * Verification uses the raw body: any JSON round-trip changes the bytes and
 * invalidates the HMAC. Signature failure is rejected before the payload is
 * parsed, so unverified data never reaches a handler.
 */
export async function receiveWebhook(input: {
  rawBody: string | Buffer;
  signature: string | null;
}): Promise<WebhookResult> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "not_configured" };
  if (!input.signature) return { ok: false, reason: "bad_signature" };

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(input.rawBody, input.signature, secret);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  // Insert-first dedup: the primary key is Stripe's event id, so a redelivery
  // collides here instead of reaching a handler twice.
  try {
    await ownerDb().stripeEvent.create({
      data: {
        id: event.id,
        type: event.type,
        connectedAccountId: (event as { account?: string }).account ?? null,
        payload: event as unknown as object,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: true, eventId: event.id, handled: false, duplicate: true };
    }
    throw error;
  }

  const handled = await dispatch(event);

  await ownerDb().stripeEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date() },
  });

  return { ok: true, eventId: event.id, handled };
}

async function dispatch(event: Stripe.Event): Promise<boolean> {
  try {
    switch (event.type) {
      case "payment_intent.processing":
        await onProcessing(event.data.object as Stripe.PaymentIntent);
        return true;

      case "payment_intent.succeeded":
        await onSucceeded(event.data.object as Stripe.PaymentIntent);
        return true;

      case "payment_intent.payment_failed":
        await onFailed(event.data.object as Stripe.PaymentIntent);
        return true;

      // Post-settlement reversal. For consumer ACH an unauthorized return can
      // arrive up to ~60 days after the money appeared to arrive.
      case "charge.dispute.created":
      case "charge.refunded":
        await onReversed(event);
        return true;

      case "account.updated":
        await onAccountUpdated(event.data.object as Stripe.Account);
        return true;

      default:
        return false;
    }
  } catch (error) {
    await ownerDb().stripeEvent.update({
      where: { id: event.id },
      data: { processError: error instanceof Error ? error.message : String(error) },
    });
    await alertJobFailure({
      job: `stripe:webhook:${event.type}`,
      startedAt: new Date(),
      fatal: error,
      context: { eventId: event.id, eventType: event.type },
    });
    throw error;
  }
}

async function findPayment(intent: Stripe.PaymentIntent) {
  // Prefer the metadata id; fall back to the intent id, since metadata can be
  // absent on intents created outside this application.
  const byMetadata = intent.metadata?.paymentId
    ? await ownerDb().payment.findUnique({ where: { id: intent.metadata.paymentId } })
    : null;
  if (byMetadata) return byMetadata;
  return ownerDb().payment.findUnique({ where: { stripePaymentIntentId: intent.id } });
}

async function onProcessing(intent: Stripe.PaymentIntent): Promise<void> {
  const payment = await findPayment(intent);
  if (!payment) return;
  // Never walk backwards: a late-arriving `processing` must not undo a
  // `succeeded` that already credited the ledger.
  if (payment.status !== "pending") return;

  await ownerDb().payment.update({
    where: { id: payment.id },
    data: { status: "processing", stripePaymentIntentId: intent.id },
  });
}

/**
 * Settlement. This is the ONLY place a payment credits the ledger.
 *
 * The credit and the status change are one transaction, and a partial unique
 * index permits exactly one payment entry per payment, so concurrent or
 * duplicated deliveries cannot double-credit.
 */
async function onSucceeded(intent: Stripe.PaymentIntent): Promise<void> {
  const payment = await findPayment(intent);
  if (!payment) return;
  if (payment.status === "succeeded") return;

  await ownerDb().$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "succeeded", settledAt: new Date(), stripePaymentIntentId: intent.id },
    });

    const existing = await tx.ledgerEntry.findFirst({
      where: { paymentId: payment.id, entryType: "payment" },
      select: { id: true },
    });
    if (existing) return;

    await tx.ledgerEntry.create({
      data: {
        leaseId: payment.leaseId,
        entryType: "payment",
        // Credits are negative: they reduce what is owed.
        amountCents: -payment.amountCents,
        paymentId: payment.id,
        leaseTenantId: await leaseTenantIdFor(tx, payment.leaseId, payment.payerUserId),
        memo: `ACH payment ${intent.id}`,
      },
    });
  });
}

async function onFailed(intent: Stripe.PaymentIntent): Promise<void> {
  const payment = await findPayment(intent);
  if (!payment) return;
  if (payment.status === "failed") return;

  const failure = intent.last_payment_error;

  await ownerDb().$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "failed",
        failureCode: failure?.code ?? null,
        failureMessage: failure?.message ?? null,
      },
    });

    // If this failed AFTER settling — which ACH can do — the credit already
    // posted and has to be undone with an offsetting entry.
    await reverseIfCredited(tx, payment.id, payment.leaseId, `ACH failed: ${failure?.code ?? "unknown"}`);
  });
}

async function onReversed(event: Stripe.Event): Promise<void> {
  const object = event.data.object as Stripe.Charge | Stripe.Dispute;
  const intentId =
    typeof (object as Stripe.Charge).payment_intent === "string"
      ? ((object as Stripe.Charge).payment_intent as string)
      : typeof (object as Stripe.Dispute).payment_intent === "string"
        ? ((object as Stripe.Dispute).payment_intent as string)
        : null;
  if (!intentId) return;

  const payment = await ownerDb().payment.findUnique({
    where: { stripePaymentIntentId: intentId },
  });
  if (!payment) return;
  if (payment.status === "reversed") return;

  await ownerDb().$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "reversed", reversedAt: new Date() },
    });
    await reverseIfCredited(tx, payment.id, payment.leaseId, `Payment reversed (${event.type})`);
  });
}

/**
 * Posts an offsetting entry if this payment ever credited the ledger.
 *
 * The ledger is append-only, so a reversal is a new positive entry pointing at
 * the original — the history of "paid then returned" stays visible, which is
 * exactly what a tenant will dispute later.
 */
async function reverseIfCredited(
  tx: Prisma.TransactionClient,
  paymentId: string,
  leaseId: string,
  memo: string,
): Promise<void> {
  const credit = await tx.ledgerEntry.findFirst({
    where: { paymentId, entryType: "payment" },
    select: { id: true, amountCents: true },
  });
  if (!credit) return;

  const already = await tx.ledgerEntry.findFirst({
    where: { reversesEntryId: credit.id },
    select: { id: true },
  });
  if (already) return;

  await tx.ledgerEntry.create({
    data: {
      leaseId,
      entryType: "reversal",
      // Positive: puts the debt back.
      amountCents: -credit.amountCents,
      paymentId,
      reversesEntryId: credit.id,
      memo,
    },
  });
}

async function leaseTenantIdFor(
  tx: Prisma.TransactionClient,
  leaseId: string,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const row = await tx.leaseTenant.findUnique({
    where: { leaseId_userId: { leaseId, userId } },
    select: { id: true },
  });
  return row?.id ?? null;
}

async function onAccountUpdated(account: Stripe.Account): Promise<void> {
  const org = await ownerDb().org.findFirst({
    where: { stripeConnectedAccountId: account.id },
    select: { id: true },
  });
  if (!org) return;

  const status =
    account.charges_enabled && account.payouts_enabled
      ? "active"
      : account.details_submitted
        ? "restricted"
        : "pending";

  await ownerDb().org.update({
    where: { id: org.id },
    data: { connectStatus: status, connectPayoutsEnabled: account.payouts_enabled ?? false },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
