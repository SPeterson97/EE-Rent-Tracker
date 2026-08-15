import { randomUUID } from "node:crypto";
import { ownerDb } from "../../db.js";
import {
  initiatePayment,
  startBankSetup,
  startConnectOnboarding,
  syncConnectStatus,
} from "../../stripe/payments.js";
import { receiveWebhook } from "../../stripe/webhooks.js";
import type { RequestContext } from "../context.js";
import { badRequest, forbidden, json, unauthorized } from "../responses.js";

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.includes("application/json")) return null;
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Confirms the caller owns the org, rather than trusting a supplied id. */
async function requireOrgOwner(userId: string, orgId: string): Promise<boolean> {
  const membership = await ownerDb().orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true },
  });
  return membership?.role === "owner";
}

/** POST /connect/onboard — returns a Stripe-hosted onboarding URL. */
export async function postConnectOnboard(ctx: RequestContext): Promise<Response> {
  if (!ctx.session) return unauthorized();

  const body = await readJson(ctx.request);
  if (!body) return badRequest("Expected a JSON body.");
  const orgId = str(body, "orgId");
  if (!orgId) return badRequest("orgId is required.");

  // Only an owner may bind a bank account to the org — this decides where all
  // of that org's rent money lands.
  if (!(await requireOrgOwner(ctx.session.userId, orgId))) {
    return forbidden("Only an organization owner can set up payouts.");
  }

  const user = await ownerDb().appUser.findUnique({
    where: { id: ctx.session.userId },
    select: { email: true },
  });

  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const link = await startConnectOnboarding({
    orgId,
    email: user!.email,
    refreshUrl: `${base}/connect/refresh?org=${orgId}`,
    returnUrl: `${base}/connect/return?org=${orgId}`,
  });

  return json({ url: link.url, expiresAt: link.expiresAt });
}

/** GET /connect/status?orgId= — re-reads capability state from Stripe. */
export async function getConnectStatus(ctx: RequestContext): Promise<Response> {
  if (!ctx.session) return unauthorized();

  const orgId = new URL(ctx.request.url).searchParams.get("orgId");
  if (!orgId) return badRequest("orgId is required.");
  if (!(await requireOrgOwner(ctx.session.userId, orgId))) return forbidden();

  return json(await syncConnectStatus(orgId));
}

/** POST /payments/bank-setup — client secret for collecting a bank account. */
export async function postBankSetup(ctx: RequestContext): Promise<Response> {
  if (!ctx.session) return unauthorized();
  const setup = await startBankSetup(ctx.session.userId);
  return json(setup);
}

/** POST /payments — a tenant pays toward their lease balance. */
export async function postPayment(ctx: RequestContext): Promise<Response> {
  if (!ctx.session) return unauthorized();

  const body = await readJson(ctx.request);
  if (!body) return badRequest("Expected a JSON body.");

  const leaseId = str(body, "leaseId");
  const paymentMethodId = str(body, "paymentMethodId");
  const rawAmount = body.amountCents;

  if (!leaseId || !paymentMethodId) return badRequest("leaseId and paymentMethodId are required.");
  if (typeof rawAmount !== "number" || !Number.isInteger(rawAmount) || rawAmount <= 0) {
    return badRequest("amountCents must be a positive whole number of cents.");
  }

  const result = await initiatePayment({
    leaseId,
    payerUserId: ctx.session.userId,
    amountCents: BigInt(rawAmount),
    paymentMethodId,
    // A client-supplied key would let a buggy client collapse two genuinely
    // separate payments into one. Generated here, returned so a retry of THIS
    // response can reuse it.
    idempotencyKey: str(body, "idempotencyKey") ?? randomUUID(),
  });

  if (!result.ok) {
    const status = result.reason === "not_on_lease" ? 403 : 409;
    return json({ error: result.reason }, { status });
  }

  return json(
    {
      paymentId: result.paymentId,
      status: result.status,
      duplicate: result.duplicate ?? false,
      // Set expectations: ACH is not instant, and the balance will not move yet.
      message: "Payment submitted. ACH transfers usually settle in 3-5 business days.",
    },
    { status: 202 },
  );
}

/**
 * POST /stripe/webhook
 *
 * Unauthenticated by design — Stripe cannot present a session. Authenticity
 * comes from the signature, verified against the RAW body: parsing and
 * re-serializing changes the bytes and invalidates the HMAC.
 *
 * Always answers 200 once the signature checks out, even if a handler failed.
 * A non-2xx makes Stripe retry, and for an unhandleable event that becomes an
 * infinite redelivery loop — the event is stored with its error for triage.
 */
export async function postStripeWebhook(ctx: RequestContext): Promise<Response> {
  const rawBody = await ctx.request.text();
  const signature = ctx.request.headers.get("stripe-signature");

  let result;
  try {
    result = await receiveWebhook({ rawBody, signature });
  } catch (error) {
    console.error("[stripe] webhook handler threw:", error);
    // Already persisted with processError by the dispatcher; do not ask Stripe
    // to retry something that will fail again.
    return json({ received: true, processed: false }, { status: 200 });
  }

  if (!result.ok) {
    const status = result.reason === "not_configured" ? 500 : 400;
    return json({ error: result.reason }, { status });
  }

  return json({
    received: true,
    eventId: result.eventId,
    handled: result.handled,
    duplicate: result.duplicate ?? false,
  });
}
