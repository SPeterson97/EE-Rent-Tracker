import type { Message } from "./mailer.js";

const APP_NAME = process.env.APP_NAME ?? "EE Rent Tracker";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function layout(heading: string, body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">
<div style="max-width:480px;margin:0 auto;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h1>
${body}
<p style="color:#666;font-size:12px;margin-top:32px">${escapeHtml(APP_NAME)}</p>
</div></body></html>`;
}

export function loginCodeEmail(args: { to: string; code: string; expiresAt: Date }): Message {
  const minutes = Math.max(1, Math.round((args.expiresAt.getTime() - Date.now()) / 60000));

  return {
    to: args.to,
    // The code is deliberately NOT in the subject line: subjects show up in
    // lock-screen notifications and shoulder-surfing range.
    subject: `Your ${APP_NAME} sign-in code`,
    text: [
      `Your sign-in code is ${args.code}`,
      ``,
      `It expires in ${minutes} minutes and can only be used once.`,
      ``,
      `If you did not request this, you can ignore this email — someone may have`,
      `mistyped their address. Your account is not at risk without this code.`,
    ].join("\n"),
    html: layout(
      `Your sign-in code`,
      `<p style="font-size:32px;letter-spacing:6px;font-weight:600;margin:0 0 16px">${escapeHtml(args.code)}</p>
<p style="margin:0 0 12px">Expires in ${minutes} minutes. Single use.</p>
<p style="color:#666;font-size:13px">If you did not request this, you can ignore this email. Your account is not at risk without the code.</p>`,
    ),
  };
}

export function invitationEmail(args: {
  to: string;
  acceptUrl: string;
  inviterName: string | null;
  orgName: string;
  kind: "tenant" | "staff";
  expiresAt: Date;
}): Message {
  const days = Math.max(1, Math.round((args.expiresAt.getTime() - Date.now()) / 86_400_000));
  const who = args.inviterName ? `${args.inviterName} (${args.orgName})` : args.orgName;
  const what =
    args.kind === "tenant"
      ? `manage your rent payments`
      : `help manage properties`;

  return {
    to: args.to,
    subject: `${who} invited you to ${APP_NAME}`,
    text: [
      `${who} has invited you to ${what} on ${APP_NAME}.`,
      ``,
      `Accept the invitation:`,
      args.acceptUrl,
      ``,
      `This link expires in ${days} days and can only be used once.`,
      `If you were not expecting this, you can ignore this email.`,
    ].join("\n"),
    html: layout(
      `${who} invited you`,
      `<p style="margin:0 0 20px">You have been invited to ${escapeHtml(what)} on ${escapeHtml(APP_NAME)}.</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(args.acceptUrl)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Accept invitation</a></p>
<p style="color:#666;font-size:13px">Expires in ${days} days, single use. If you were not expecting this, ignore this email.</p>`,
    ),
  };
}
