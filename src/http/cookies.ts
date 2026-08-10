/**
 * Cookie handling for session and CSRF tokens.
 *
 * Built on Web-standard Request/Response rather than a framework, because that
 * is exactly what Next.js route handlers receive — mounting this later is an
 * adapter, not a rewrite.
 */

export const SESSION_COOKIE = "ee_session";
export const CSRF_COOKIE = "ee_csrf";

/** Production requires HTTPS; local development over http would break Secure. */
function isSecureContext(): boolean {
  return process.env.NODE_ENV === "production" || process.env.FORCE_SECURE_COOKIES === "1";
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  expires?: Date;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/"];

  // Lax rather than Strict: Strict would drop the cookie when a user arrives by
  // clicking the login link in their email, which is the primary flow here.
  parts.push("SameSite=Lax");

  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (isSecureContext()) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);

  return parts.join("; ");
}

export function sessionCookie(token: string, expiresAt: Date): string {
  return serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    maxAgeSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}

/**
 * Readable by JavaScript on purpose — the client has to echo it back in a
 * header for the double-submit check to mean anything.
 */
export function csrfCookie(token: string, expiresAt: Date): string {
  return serializeCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    maxAgeSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}

export function clearedCookies(): string[] {
  const expired = { maxAgeSeconds: 0, expires: new Date(0) };
  return [
    serializeCookie(SESSION_COOKIE, "", { ...expired, httpOnly: true }),
    serializeCookie(CSRF_COOKIE, "", { ...expired, httpOnly: false }),
  ];
}
