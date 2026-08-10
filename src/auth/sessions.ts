import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ownerDb } from "../db.js";

/**
 * Opaque server-side sessions. Every function here uses ownerDb() because
 * session lookup is what *establishes* identity — there is no current user to
 * scope an RLS policy against until after it succeeds.
 */

const SESSION_TTL_DAYS = 30;

/** Avoids a database write on every single request. */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

/**
 * A session token is 256 bits from a CSPRNG, so a plain SHA-256 digest is
 * sufficient — there is no feasible offline search over that space. Login
 * codes are different and need a keyed hash; see codes.ts.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedSession {
  /** Returned to the client exactly once. Only its hash is stored. */
  token: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  ctx: SessionContext = {},
): Promise<IssuedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await ownerDb().session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: ctx.userAgent ?? null,
      createdIp: ctx.ip ?? null,
    },
  });

  return { token, expiresAt };
}

export interface ValidatedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Resolves a bearer token to a user, or null. Returns null for every failure
 * mode — expired, revoked, unknown — so callers cannot distinguish them.
 */
export async function validateSession(
  token: string | null | undefined,
): Promise<ValidatedSession | null> {
  if (!token) return null;

  const session = await ownerDb().session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
    },
  });

  if (!session) return null;
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
    await ownerDb().session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
  }

  return {
    sessionId: session.id,
    userId: session.userId,
    expiresAt: session.expiresAt,
  };
}

/** Sign out. Idempotent, and silent about tokens that were never valid. */
export async function revokeSession(token: string): Promise<void> {
  await ownerDb().session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Sign out everywhere. Call this on email change, on suspected compromise, and
 * whenever a user is removed from a lease or org — a stale session must not
 * outlive the access that justified it.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const { count } = await ownerDb().session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

/** Housekeeping: sessions past expiry are dead weight. Safe to run nightly. */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await ownerDb().session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

/** Exposed for tests that need to compare digests without leaking timing. */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(hashToken(a), "hex");
  const bb = Buffer.from(hashToken(b), "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
