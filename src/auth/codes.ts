import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { ownerDb } from "../db.js";
import { env } from "../env.js";
import { createSession, type IssuedSession } from "./sessions.js";

/**
 * Email login codes.
 *
 * Uses ownerDb() throughout: these tables (app_user, auth_code) deliberately
 * carry no RLS, because authentication runs before any identity exists to
 * scope a policy against.
 */

const CODE_TTL_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_REQUESTS_PER_EMAIL_PER_HOUR = 5;
const MAX_REQUESTS_PER_IP_PER_HOUR = 20;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A 6-digit code is about 20 bits of entropy — trivially brute-forced offline
 * if the database leaks. Keying the hash with a server-side secret means the
 * stored value is useless without AUTH_SECRET, which lives somewhere the
 * database does not.
 */
function hashCode(email: string, code: string): string {
  return createHmac("sha256", env().AUTH_SECRET).update(`${normalizeEmail(email)}:${code}`).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function generateCode(): string {
  // randomInt is CSPRNG-backed and unbiased, unlike Math.random() * range.
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export type CodeDeliverer = (args: {
  email: string;
  code: string;
  expiresAt: Date;
}) => Promise<void> | void;

export type RequestCodeResult =
  | { accepted: true }
  | { accepted: false; reason: "rate_limited" };

/**
 * Issues a login code, if the address belongs to an existing account.
 *
 * Returns `{ accepted: true }` whether or not the account exists. Telling the
 * caller "no such user" would turn this endpoint into a membership oracle —
 * anyone could test whether a given person is a tenant here. The only visible
 * difference is rate limiting, which is a deliberate trade.
 *
 * Invited-but-not-yet-registered addresses get nothing: an invitation is
 * accepted with its own emailed token, and that is what creates the account.
 */
export async function requestLoginCode(input: {
  email: string;
  ip?: string | null;
  deliver?: CodeDeliverer;
}): Promise<RequestCodeResult> {
  const email = normalizeEmail(input.email);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [emailRequests, ipRequests] = await Promise.all([
    ownerDb().authCode.count({ where: { email, createdAt: { gte: oneHourAgo } } }),
    input.ip
      ? ownerDb().authCode.count({
          where: { requestIp: input.ip, createdAt: { gte: oneHourAgo } },
        })
      : Promise.resolve(0),
  ]);

  if (
    emailRequests >= MAX_REQUESTS_PER_EMAIL_PER_HOUR ||
    ipRequests >= MAX_REQUESTS_PER_IP_PER_HOUR
  ) {
    return { accepted: false, reason: "rate_limited" };
  }

  const user = await ownerDb().appUser.findUnique({
    where: { email },
    select: { id: true },
  });

  // No account: record nothing, reveal nothing, but still return accepted.
  if (!user) return { accepted: true };

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  // A partial unique index permits only one live code per address, so issuing
  // a replacement means retiring the previous one first. This is also what
  // makes "resend" invalidate the earlier code rather than leaving two valid.
  await ownerDb().$transaction(async (tx) => {
    // Retire rather than delete: the partial unique index only counts rows with
    // consumed_at IS NULL, so marking them keeps the audit trail without
    // blocking the replacement.
    await tx.authCode.updateMany({
      where: { email, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.authCode.create({
      data: { email, codeHash: hashCode(email, code), expiresAt, requestIp: input.ip ?? null },
    });
  });

  await input.deliver?.({ email, code, expiresAt });

  return { accepted: true };
}

export type VerifyCodeResult =
  | { ok: true; userId: string; session: IssuedSession }
  | { ok: false; reason: "invalid_or_expired" | "too_many_attempts" };

/**
 * Exchanges a code for a session.
 *
 * Every failure collapses to `invalid_or_expired` so the response cannot be
 * used to distinguish "wrong code" from "no such account" from "already used".
 * `too_many_attempts` is separate only because the user needs to be told to
 * start over rather than keep guessing.
 */
export async function verifyLoginCode(input: {
  email: string;
  code: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<VerifyCodeResult> {
  const email = normalizeEmail(input.email);

  const record = await ownerDb().authCode.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) return { ok: false, reason: "invalid_or_expired" };

  if (record.expiresAt.getTime() <= Date.now()) {
    await consume(record.id);
    return { ok: false, reason: "invalid_or_expired" };
  }

  if (record.attemptCount >= MAX_VERIFY_ATTEMPTS) {
    // Burn it, so a locked-out row stops occupying the live-code slot.
    await consume(record.id);
    return { ok: false, reason: "too_many_attempts" };
  }

  if (!constantTimeEquals(record.codeHash, hashCode(email, input.code))) {
    await ownerDb().authCode.update({
      where: { id: record.id },
      data: { attemptCount: { increment: 1 } },
    });
    return { ok: false, reason: "invalid_or_expired" };
  }

  const user = await ownerDb().appUser.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    await consume(record.id);
    return { ok: false, reason: "invalid_or_expired" };
  }

  // Single-use: consumed before the session exists, so a replayed request
  // cannot mint a second session even under concurrency.
  await ownerDb().$transaction(async (tx) => {
    await tx.authCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    await tx.appUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  });

  const session = await createSession(user.id, { ip: input.ip, userAgent: input.userAgent });
  return { ok: true, userId: user.id, session };
}

function consume(id: string): Promise<unknown> {
  return ownerDb().authCode.update({ where: { id }, data: { consumedAt: new Date() } });
}

/** Housekeeping for spent and expired codes. Safe to run nightly. */
export async function purgeStaleAuthCodes(): Promise<number> {
  const { count } = await ownerDb().authCode.deleteMany({
    where: {
      OR: [
        { consumedAt: { not: null } },
        { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return count;
}

export const authCodePolicy = {
  CODE_TTL_MINUTES,
  MAX_VERIFY_ATTEMPTS,
  MAX_REQUESTS_PER_EMAIL_PER_HOUR,
  MAX_REQUESTS_PER_IP_PER_HOUR,
} as const;
