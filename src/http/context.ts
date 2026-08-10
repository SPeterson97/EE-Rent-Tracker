import { randomBytes, timingSafeEqual } from "node:crypto";
import { validateSession, type ValidatedSession } from "../auth/index.js";
import { CSRF_COOKIE, readCookie, SESSION_COOKIE } from "./cookies.js";

export const CSRF_HEADER = "x-csrf-token";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Client IP, used for rate limiting.
 *
 * X-Forwarded-For is trusted ONLY when TRUST_PROXY=1. Trusting it
 * unconditionally would let anyone defeat per-IP limits by inventing a header,
 * which is worse than having no limit at all because it looks like it works.
 * Behind a proxy, the rightmost entry is the one the proxy itself observed;
 * everything to its left is client-supplied and forgeable.
 */
export function clientIp(request: Request, socketAddress?: string | null): string | null {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
      const nearest = hops[hops.length - 1];
      if (nearest) return nearest;
    }
  }
  return socketAddress ?? null;
}

export interface RequestContext {
  request: Request;
  ip: string | null;
  userAgent: string | null;
  session: ValidatedSession | null;
}

export async function buildContext(
  request: Request,
  socketAddress?: string | null,
): Promise<RequestContext> {
  const token = readCookie(request, SESSION_COOKIE);
  return {
    request,
    ip: clientIp(request, socketAddress),
    userAgent: request.headers.get("user-agent"),
    session: await validateSession(token),
  };
}

function safeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Double-submit CSRF check.
 *
 * SameSite=Lax already blocks cross-site POSTs in current browsers, so this is
 * defence in depth — it also covers same-site subdomain takeover, which
 * SameSite does not. Only enforced when a session cookie is actually present:
 * unauthenticated endpoints have no ambient authority to abuse.
 */
export function csrfFailure(request: Request): Response | null {
  if (!UNSAFE_METHODS.has(request.method)) return null;
  if (!readCookie(request, SESSION_COOKIE)) return null;

  const cookieToken = readCookie(request, CSRF_COOKIE);
  const headerToken = request.headers.get(CSRF_HEADER);

  if (!cookieToken || !headerToken || !safeEquals(cookieToken, headerToken)) {
    return Response.json(
      { error: "csrf_failed", message: "Missing or invalid CSRF token." },
      { status: 403 },
    );
  }
  return null;
}
