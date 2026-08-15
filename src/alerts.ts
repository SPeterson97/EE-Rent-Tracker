import { hostname } from "node:os";
import { mailer } from "./email/mailer.js";

/**
 * Operator alerts for background jobs.
 *
 * Background failures are silent by construction — nobody is watching a cron
 * run. The nightly job also deliberately skips a failing lease rather than
 * aborting the whole run, which is right for availability but means a single
 * broken lease could go unnoticed for months while its rent is never charged.
 * This is the thing that makes that visible.
 */

export interface JobFailure {
  job: string;
  startedAt: Date;
  /** Per-item failures the job survived and continued past. */
  itemErrors?: { leaseId: string; stage: string; message: string }[];
  /** Set when the job itself threw and produced no result at all. */
  fatal?: unknown;
  /** Counters or anything else useful for triage. */
  context?: Record<string, unknown>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`;
  }
  return String(error);
}

function environmentBlock(startedAt: Date): string {
  return [
    `host:      ${hostname()}`,
    `env:       ${process.env.NODE_ENV ?? "development"}`,
    `node:      ${process.version}`,
    `started:   ${startedAt.toISOString()}`,
    `finished:  ${new Date().toISOString()}`,
    `duration:  ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`,
    // Which database, without leaking the password.
    `database:  ${redactUrl(process.env.DATABASE_URL)}`,
  ].join("\n");
}

/** Host and database only — credentials must never reach an inbox. */
function redactUrl(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    const parsed = new URL(url);
    return `${parsed.username}@${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Emails an operator about a failed or partially failed job.
 *
 * Never throws: an alert that crashes the job it is reporting on would turn a
 * partial failure into a total one.
 */
export async function alertJobFailure(failure: JobFailure): Promise<boolean> {
  const to = process.env.ALERT_EMAIL;
  if (!to) {
    console.error(
      `[alerts] ${failure.job} failed but ALERT_EMAIL is unset; nobody was notified.`,
    );
    return false;
  }

  const itemErrors = failure.itemErrors ?? [];
  const headline = failure.fatal
    ? `${failure.job} failed`
    : `${failure.job} completed with ${itemErrors.length} error${itemErrors.length === 1 ? "" : "s"}`;

  const sections: string[] = [headline, "", environmentBlock(failure.startedAt)];

  if (failure.context && Object.keys(failure.context).length > 0) {
    sections.push("", "Context:", JSON.stringify(failure.context, bigintSafe, 2));
  }

  if (failure.fatal) {
    sections.push("", "Fatal error:", describeError(failure.fatal));
  }

  if (itemErrors.length > 0) {
    sections.push("", `Per-lease errors (${itemErrors.length}):`);
    for (const item of itemErrors) {
      sections.push(`  lease ${item.leaseId} [${item.stage}]: ${item.message}`);
    }
    sections.push(
      "",
      "These leases were skipped. The run is safe to re-run once the cause is",
      "fixed — every generated charge is idempotent, so nothing double-charges.",
    );
  }

  const text = sections.join("\n");

  try {
    await mailer().send({
      to,
      subject: `[${process.env.NODE_ENV ?? "dev"}] ${headline}`,
      text,
    });
    return true;
  } catch (error) {
    // Last resort: the alert channel itself is down. Log loudly and carry on.
    console.error("[alerts] could not send failure alert:", error);
    console.error(text);
    return false;
  }
}

/** JSON.stringify throws on BigInt, and job summaries carry cent amounts. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
