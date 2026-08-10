import {
  acceptInvitation,
  createInvitation,
  registerLandlord,
  requestLoginCode,
  revokeSession,
  verifyLoginCode,
} from "../../auth/index.js";
import { asUser, ownerDb } from "../../db.js";
import { mailer } from "../../email/mailer.js";
import { invitationEmail, loginCodeEmail } from "../../email/templates.js";
import { clearedCookies, csrfCookie, readCookie, SESSION_COOKIE, sessionCookie } from "../cookies.js";
import { newCsrfToken, type RequestContext } from "../context.js";
import { badRequest, forbidden, json, noContent, unauthorized } from "../responses.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** Issues session + CSRF cookies together. A session without its CSRF partner
 *  would fail every subsequent state-changing request. */
function loginResponse(
  payload: Record<string, unknown>,
  session: { token: string; expiresAt: Date },
): Response {
  const csrf = newCsrfToken();
  const response = json({ ...payload, csrfToken: csrf }, { status: 200 });
  response.headers.append("set-cookie", sessionCookie(session.token, session.expiresAt));
  response.headers.append("set-cookie", csrfCookie(csrf, session.expiresAt));
  return response;
}

/**
 * POST /auth/request-code
 *
 * Always 202, whether or not the address has an account, and the code is never
 * in the response body — only in the email. Returning it, even in development,
 * would make it trivially harvestable.
 */
export async function postRequestCode(ctx: RequestContext): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return badRequest("Expected a JSON body.");

  const email = str(body, "email");
  if (!email || !EMAIL_RE.test(email)) return badRequest("A valid email address is required.");

  const result = await requestLoginCode({
    email,
    ip: ctx.ip,
    deliver: async ({ email: to, code, expiresAt }) => {
      await mailer().send(loginCodeEmail({ to, code, expiresAt }));
    },
  });

  if (!result.accepted) {
    return json(
      { error: "rate_limited", message: "Too many sign-in attempts. Try again later." },
      { status: 429, headers: { "retry-after": "3600" } },
    );
  }

  return json({ accepted: true }, { status: 202 });
}

/** POST /auth/verify-code — exchanges a code for a session. */
export async function postVerifyCode(ctx: RequestContext): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return badRequest("Expected a JSON body.");

  const email = str(body, "email");
  const code = str(body, "code");
  if (!email || !code) return badRequest("Email and code are required.");

  const result = await verifyLoginCode({
    email,
    code,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  if (!result.ok) {
    const status = result.reason === "too_many_attempts" ? 429 : 401;
    return json(
      {
        error: result.reason,
        message:
          result.reason === "too_many_attempts"
            ? "Too many attempts. Request a new code."
            : "That code is not valid.",
      },
      { status },
    );
  }

  return loginResponse({ userId: result.userId }, result.session);
}

/** POST /auth/register — landlord self-registration. */
export async function postRegisterLandlord(ctx: RequestContext): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return badRequest("Expected a JSON body.");

  const email = str(body, "email");
  const orgName = str(body, "orgName");
  if (!email || !EMAIL_RE.test(email)) return badRequest("A valid email address is required.");
  if (!orgName) return badRequest("An organization name is required.");

  const result = await registerLandlord({
    email,
    orgName,
    displayName: str(body, "displayName"),
    ctx: { ip: ctx.ip, userAgent: ctx.userAgent },
  });

  if (!result.ok) {
    // Registration inherently reveals that an address is taken. Kept vague, and
    // it does not distinguish a landlord from a tenant.
    return json(
      { error: "email_unavailable", message: "That email cannot be registered." },
      { status: 409 },
    );
  }

  return loginResponse({ userId: result.userId, orgId: result.orgId }, result.session);
}

/** POST /auth/accept-invite — the only path that creates a tenant. */
export async function postAcceptInvite(ctx: RequestContext): Promise<Response> {
  const body = await readJson(ctx.request);
  if (!body) return badRequest("Expected a JSON body.");

  const token = str(body, "token");
  if (!token) return badRequest("An invitation token is required.");

  const result = await acceptInvitation({
    token,
    displayName: str(body, "displayName"),
    ctx: { ip: ctx.ip, userAgent: ctx.userAgent },
  });

  if (!result.ok) {
    return json(
      { error: "invalid_or_expired", message: "That invitation is no longer valid." },
      { status: 410 },
    );
  }

  return loginResponse({ userId: result.userId, role: result.role }, result.session);
}

/** POST /auth/invitations — landlord invites a tenant or staff member. */
export async function postCreateInvitation(ctx: RequestContext): Promise<Response> {
  if (!ctx.session) return unauthorized();

  const body = await readJson(ctx.request);
  if (!body) return badRequest("Expected a JSON body.");

  const email = str(body, "email");
  if (!email || !EMAIL_RE.test(email)) return badRequest("A valid email address is required.");

  const orgId = str(body, "orgId");
  const leaseId = str(body, "leaseId");
  const orgRole = str(body, "orgRole");

  const result = await createInvitation({
    inviterUserId: ctx.session.userId,
    email,
    ...(orgId ? { orgId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(orgRole === "owner" || orgRole === "staff" ? { orgRole } : {}),
  });

  if (!result.ok) {
    const status = result.reason === "not_authorized" ? 403 : 400;
    return json({ error: result.reason }, { status });
  }

  // Look up context for the email. ownerDb is justified here: the authorization
  // decision was already made above by createInvitation.
  const [inviter, org] = await Promise.all([
    ownerDb().appUser.findUnique({
      where: { id: ctx.session.userId },
      select: { displayName: true },
    }),
    orgId
      ? ownerDb().org.findUnique({ where: { id: orgId }, select: { name: true } })
      : ownerDb()
          .lease.findUnique({
            where: { id: leaseId! },
            select: { unit: { select: { property: { select: { org: { select: { name: true } } } } } } },
          })
          .then((l) => l?.unit.property.org ?? null),
  ]);

  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  await mailer().send(
    invitationEmail({
      to: email,
      acceptUrl: `${base}/accept-invite?token=${encodeURIComponent(result.token)}`,
      inviterName: inviter?.displayName ?? null,
      orgName: org?.name ?? "your landlord",
      kind: orgId ? "staff" : "tenant",
      expiresAt: result.expiresAt,
    }),
  );

  // The token is emailed, never returned — an API response is logged and cached
  // in places an inbox is not.
  return json({ invitationId: result.invitationId, expiresAt: result.expiresAt }, { status: 201 });
}

/** POST /auth/logout */
export async function postLogout(ctx: RequestContext): Promise<Response> {
  const token = readCookie(ctx.request, SESSION_COOKIE);
  if (token) await revokeSession(token);

  const response = noContent();
  for (const cookie of clearedCookies()) response.headers.append("set-cookie", cookie);
  return response;
}

/**
 * GET /auth/me — identity plus the memberships that determine what the UI
 * should show. Read through asUser so RLS governs it, not application code.
 */
export async function getMe(ctx: RequestContext): Promise<Response> {
  if (!ctx.session) return unauthorized();

  const userId = ctx.session.userId;
  const user = await ownerDb().appUser.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, createdAt: true },
  });
  if (!user) return unauthorized();

  const { orgs, leases } = await asUser(userId, async (tx) => ({
    orgs: await tx.orgMember.findMany({
      select: { role: true, org: { select: { id: true, name: true } } },
    }),
    leases: await tx.leaseTenant.findMany({
      where: { userId },
      select: { lease: { select: { id: true, unit: { select: { label: true } } } } },
    }),
  }));

  return json({
    user,
    // Derived from memberships rather than stored on the user, which is what
    // lets one identity hold both roles later without a migration.
    isLandlord: orgs.length > 0,
    isTenant: leases.length > 0,
    orgs: orgs.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role })),
    // `unit` is a required relation, so Prisma types it non-nullable — but RLS
    // filters rows after the join, which means a missing policy yields null on
    // a field the type system says cannot be null. Defensive by necessity.
    leases: leases.map((t) => ({ id: t.lease.id, unit: t.lease.unit?.label ?? null })),
  });
}

export { forbidden };
