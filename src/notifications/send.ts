import { ownerDb } from "../db.js";
import { mailer, type Message } from "../email/mailer.js";

/**
 * Notification dispatch.
 *
 * Every send is keyed so it happens once. Background jobs retry, webhooks
 * redeliver, and the nightly run is deliberately safe to re-run — without a
 * dedupe key a tenant would get the same "rent is due" email every time
 * anything reran.
 *
 * The key is claimed in the database BEFORE the mail is attempted. Sending
 * first and recording after would double-send whenever the process died in
 * between, and a duplicate "your payment failed" is worse than a missing one.
 */

export type NotificationKind =
  | "rent_due"
  | "payment_received"
  | "payment_failed"
  | "late_fee_posted"
  | "deposit_deadline";

export interface SendResult {
  sent: boolean;
  reason?: "duplicate" | "no_recipient" | "delivery_failed";
}

export async function notify(input: {
  userId: string;
  kind: NotificationKind;
  /** Must be stable for the same logical event, e.g. rent_due:<lease>:2026-11. */
  dedupeKey: string;
  message: Message;
}): Promise<SendResult> {
  if (!input.message.to) return { sent: false, reason: "no_recipient" };

  // Claim the key first. A unique constraint makes this the arbiter under
  // concurrency, so two workers cannot both decide they are the sender.
  let logId: string;
  try {
    const row = await ownerDb().notificationLog.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        channel: "email",
      },
      select: { id: true },
    });
    logId = row.id;
  } catch (error) {
    if (isUniqueViolation(error)) return { sent: false, reason: "duplicate" };
    throw error;
  }

  try {
    await mailer().send(input.message);
    await ownerDb().notificationLog.update({
      where: { id: logId },
      data: { sentAt: new Date() },
    });
    return { sent: true };
  } catch (error) {
    // Record the failure but leave the row in place: the key stays claimed, so
    // a retry storm cannot flood someone's inbox. Unsent rows are visible via
    // the `notification_pending` partial index for manual replay.
    await ownerDb().notificationLog.update({
      where: { id: logId },
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return { sent: false, reason: "delivery_failed" };
  }
}

/** Rows whose mail never went out, for triage or replay. */
export async function pendingNotifications(limit = 100) {
  return ownerDb().notificationLog.findMany({
    where: { sentAt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, userId: true, kind: true, dedupeKey: true, error: true, createdAt: true },
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
