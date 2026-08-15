import type { Message } from "../email/mailer.js";
import { formatCents } from "../db.js";

const APP_NAME = process.env.APP_NAME ?? "EE Rent Tracker";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function layout(heading: string, body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">
<div style="max-width:520px;margin:0 auto;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h1>
${body}
<p style="color:#666;font-size:12px;margin-top:32px">${escapeHtml(APP_NAME)}</p>
</div></body></html>`;
}

function portalLink(path = "/"): string {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  return `${base}${path}`;
}

function longDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function rentDueEmail(args: {
  to: string;
  unitLabel: string;
  amountCents: bigint;
  dueOn: Date;
  daysUntil: number;
}): Message {
  const when = args.daysUntil === 0 ? "today" : `in ${args.daysUntil} days`;
  return {
    to: args.to,
    subject: `Rent for ${args.unitLabel} is due ${when}`,
    text: [
      `Your share of rent for ${args.unitLabel} is ${formatCents(args.amountCents)}, due ${longDate(args.dueOn)}.`,
      ``,
      `Pay or review your balance: ${portalLink("/")}`,
    ].join("\n"),
    html: layout(
      `Rent is due ${when}`,
      `<p style="margin:0 0 8px;font-size:28px;font-weight:600">${escapeHtml(formatCents(args.amountCents))}</p>
<p style="margin:0 0 20px;color:#444">${escapeHtml(args.unitLabel)} — due ${escapeHtml(longDate(args.dueOn))}</p>
<p><a href="${portalLink("/")}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">View balance</a></p>`,
    ),
  };
}

export function paymentReceivedEmail(args: {
  to: string;
  amountCents: bigint;
  unitLabel: string;
  remainingCents: bigint;
}): Message {
  const settled = args.remainingCents <= 0n;
  return {
    to: args.to,
    subject: `Payment received — ${formatCents(args.amountCents)}`,
    text: [
      `We received your payment of ${formatCents(args.amountCents)} for ${args.unitLabel}.`,
      ``,
      settled
        ? `Your balance is now settled. Thank you.`
        : `Remaining balance on this lease: ${formatCents(args.remainingCents)}.`,
      ``,
      `This email is your receipt.`,
    ].join("\n"),
    html: layout(
      `Payment received`,
      `<p style="margin:0 0 8px;font-size:28px;font-weight:600">${escapeHtml(formatCents(args.amountCents))}</p>
<p style="margin:0 0 20px;color:#444">${escapeHtml(args.unitLabel)}</p>
<p style="margin:0 0 20px">${
        settled
          ? "Your balance is now settled. Thank you."
          : `Remaining balance on this lease: <strong>${escapeHtml(formatCents(args.remainingCents))}</strong>`
      }</p>
<p style="color:#666;font-size:13px">This email is your receipt.</p>`,
    ),
  };
}

/**
 * The highest-urgency message in the system. An ACH return can arrive days or
 * weeks after the money appeared to arrive, so the tenant may believe they are
 * paid up while their balance has quietly gone back up.
 */
export function paymentFailedEmail(args: {
  to: string;
  amountCents: bigint;
  unitLabel: string;
  reason: string | null;
  afterSettlement: boolean;
}): Message {
  const explanation = args.afterSettlement
    ? `This payment initially went through, but your bank has since returned it. Your balance has been adjusted back.`
    : `Your bank declined the transfer, so nothing was collected.`;

  return {
    to: args.to,
    subject: `Action needed: payment of ${formatCents(args.amountCents)} did not go through`,
    text: [
      `Your payment of ${formatCents(args.amountCents)} for ${args.unitLabel} did not complete.`,
      ``,
      explanation,
      args.reason ? `\nReason given by the bank: ${args.reason}` : ``,
      ``,
      `Please make another payment to avoid late fees: ${portalLink("/")}`,
      ``,
      `If you believe this is a mistake, contact your landlord before re-trying —`,
      `repeated returns can incur bank fees.`,
    ].join("\n"),
    html: layout(
      `Payment did not go through`,
      `<p style="margin:0 0 8px;font-size:28px;font-weight:600">${escapeHtml(formatCents(args.amountCents))}</p>
<p style="margin:0 0 16px;color:#444">${escapeHtml(args.unitLabel)}</p>
<p style="margin:0 0 16px">${escapeHtml(explanation)}</p>
${args.reason ? `<p style="margin:0 0 16px;color:#444">Reason given by the bank: ${escapeHtml(args.reason)}</p>` : ""}
<p style="margin:0 0 20px"><a href="${portalLink("/")}" style="background:#b42318;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Make a payment</a></p>
<p style="color:#666;font-size:13px">If you believe this is a mistake, contact your landlord before re-trying — repeated returns can incur bank fees.</p>`,
    ),
  };
}

export function lateFeeEmail(args: {
  to: string;
  amountCents: bigint;
  unitLabel: string;
  period: string;
  balanceCents: bigint;
}): Message {
  return {
    to: args.to,
    subject: `A late fee of ${formatCents(args.amountCents)} was added`,
    text: [
      `A late fee of ${formatCents(args.amountCents)} has been added to ${args.unitLabel} for ${args.period}.`,
      ``,
      `Current balance: ${formatCents(args.balanceCents)}`,
      ``,
      `View details: ${portalLink("/")}`,
      ``,
      `If you have already paid or believe this is an error, contact your landlord.`,
    ].join("\n"),
    html: layout(
      `Late fee added`,
      `<p style="margin:0 0 8px;font-size:28px;font-weight:600">${escapeHtml(formatCents(args.amountCents))}</p>
<p style="margin:0 0 16px;color:#444">${escapeHtml(args.unitLabel)} — ${escapeHtml(args.period)}</p>
<p style="margin:0 0 20px">Current balance: <strong>${escapeHtml(formatCents(args.balanceCents))}</strong></p>
<p style="color:#666;font-size:13px">If you have already paid or believe this is an error, contact your landlord.</p>`,
    ),
  };
}

/**
 * Landlord-facing. Missing the statutory deadline forfeits the right to withhold
 * anything and can expose the landlord to double damages, so this escalates.
 */
export function depositDeadlineEmail(args: {
  to: string;
  unitLabel: string;
  dueOn: Date;
  daysRemaining: number;
  amountCents: bigint;
}): Message {
  const urgency =
    args.daysRemaining <= 3 ? "URGENT: " : args.daysRemaining <= 7 ? "Reminder: " : "";
  return {
    to: args.to,
    subject: `${urgency}Security deposit for ${args.unitLabel} must be returned by ${longDate(args.dueOn)}`,
    text: [
      `The security deposit for ${args.unitLabel} (${formatCents(args.amountCents)}) must be`,
      `returned with an itemized statement by ${longDate(args.dueOn)} — ${args.daysRemaining} day(s) away.`,
      ``,
      `In Pennsylvania, missing this deadline forfeits your right to withhold any`,
      `portion of the deposit, and wrongful withholding can expose you to double`,
      `damages. Send the itemized list even if you are returning the full amount.`,
      ``,
      `Review: ${portalLink("/")}`,
    ].join("\n"),
    html: layout(
      `Deposit return deadline approaching`,
      `<p style="margin:0 0 16px">The security deposit for <strong>${escapeHtml(args.unitLabel)}</strong> (${escapeHtml(formatCents(args.amountCents))}) must be returned with an itemized statement by <strong>${escapeHtml(longDate(args.dueOn))}</strong> — ${args.daysRemaining} day(s) away.</p>
<p style="margin:0 0 16px;padding:12px;background:#fff4ed;border-left:3px solid #b42318;color:#444;font-size:14px">In Pennsylvania, missing this deadline forfeits your right to withhold any portion of the deposit, and wrongful withholding can expose you to double damages. Send the itemized list even if returning the full amount.</p>
<p><a href="${portalLink("/")}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Review deposit</a></p>`,
    ),
  };
}
