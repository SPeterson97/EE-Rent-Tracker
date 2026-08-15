import { buildContext, csrfFailure } from "./context.js";
import { internalError, json, methodNotAllowed, notFound } from "./responses.js";
import {
  getMe,
  postAcceptInvite,
  postCreateInvitation,
  postLogout,
  postRegisterLandlord,
  postRequestCode,
  postVerifyCode,
} from "./routes/auth.js";
import {
  getConnectStatus,
  postBankSetup,
  postConnectOnboard,
  postPayment,
  postStripeWebhook,
} from "./routes/payments.js";
import type { RequestContext } from "./context.js";

type Handler = (ctx: RequestContext) => Promise<Response>;

/**
 * Routes are exact-match only for now. There is no path-parameter matching
 * because nothing needs it yet, and a hand-rolled pattern matcher is a common
 * source of authorization bypasses.
 */
const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/auth/request-code": { POST: postRequestCode },
  "/auth/verify-code": { POST: postVerifyCode },
  "/auth/register": { POST: postRegisterLandlord },
  "/auth/accept-invite": { POST: postAcceptInvite },
  "/auth/invitations": { POST: postCreateInvitation },
  "/auth/logout": { POST: postLogout },
  "/auth/me": { GET: getMe },

  "/connect/onboard": { POST: postConnectOnboard },
  "/connect/status": { GET: getConnectStatus },
  "/payments/bank-setup": { POST: postBankSetup },
  "/payments": { POST: postPayment },
  "/stripe/webhook": { POST: postStripeWebhook },
};

/**
 * Stripe signs the raw request body and cannot present a session cookie, so the
 * webhook route is exempt from the double-submit CSRF check. It is not
 * unprotected — the signature is the authentication, and it is strictly
 * stronger than a cookie the browser would send automatically.
 */
const CSRF_EXEMPT = new Set(["/stripe/webhook"]);

/**
 * The whole application as one Request -> Response function.
 *
 * This signature is what Next.js route handlers, Hono, Bun, and Deno all speak,
 * so mounting it anywhere is an adapter rather than a port.
 */
export async function handle(
  request: Request,
  socketAddress?: string | null,
): Promise<Response> {
  try {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return json({ ok: true });
    }

    const methods = ROUTES[pathname];
    if (!methods) return notFound();

    const handler = methods[request.method];
    if (!handler) return methodNotAllowed(Object.keys(methods));

    // Checked before the handler runs, and before any session work, so a forged
    // cross-site request cannot cause side effects on the way to being rejected.
    if (!CSRF_EXEMPT.has(pathname)) {
      const csrfProblem = csrfFailure(request);
      if (csrfProblem) return csrfProblem;
    }

    const ctx = await buildContext(request, socketAddress);
    return await handler(ctx);
  } catch (error) {
    return internalError(error);
  }
}
