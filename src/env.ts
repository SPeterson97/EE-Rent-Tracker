/**
 * Fail-fast environment validation.
 *
 * Everything here was learned the tedious way: a missing AUTH_SECRET first
 * surfaced deep inside a database transaction, with a stack trace pointing at
 * Prisma rather than at the actual cause. Checking once at startup turns that
 * into one obvious line before anything runs.
 */

const MIN_SECRET_LENGTH = 32;

export interface Env {
  /** Owner role. Migrations and trusted jobs. Bypasses RLS. */
  DATABASE_URL: string;
  /** Non-owner role. Everything request-scoped. RLS applies. */
  APP_DATABASE_URL: string;
  /** Pepper for login-code hashing. Distinct per environment. */
  AUTH_SECRET: string;
}

function fail(problems: string[]): never {
  throw new Error(
    `Environment is not usable:\n${problems.map((p) => `  - ${p}`).join("\n")}\n\n` +
      `Copy .env.example to .env and fill it in, or select another file with ENV_FILE=.`,
  );
}

export function loadEnv(): Env {
  const problems: string[] = [];
  const get = (name: keyof Env): string => {
    const value = process.env[name];
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };

  const DATABASE_URL = get("DATABASE_URL");
  const APP_DATABASE_URL = get("APP_DATABASE_URL");
  const AUTH_SECRET = get("AUTH_SECRET");

  if (AUTH_SECRET && AUTH_SECRET.length < MIN_SECRET_LENGTH) {
    problems.push(
      `AUTH_SECRET is ${AUTH_SECRET.length} characters; use at least ${MIN_SECRET_LENGTH} ` +
        `(openssl rand -base64 32)`,
    );
  }

  // The two URLs must name different roles. If they match, the application is
  // connecting as the table owner and every RLS policy is silently inert —
  // which looks completely healthy right up until one landlord reads another's
  // ledger. Worth refusing to start over.
  if (DATABASE_URL && APP_DATABASE_URL) {
    try {
      const owner = new URL(DATABASE_URL).username;
      const app = new URL(APP_DATABASE_URL).username;
      if (owner && app && owner === app) {
        problems.push(
          `DATABASE_URL and APP_DATABASE_URL both connect as "${app}". The app role must ` +
            `not own the tables, or row level security does not apply. See MIGRATIONS.md.`,
        );
      }
    } catch {
      problems.push("DATABASE_URL or APP_DATABASE_URL is not a valid connection URL");
    }
  }

  if (problems.length > 0) fail(problems);

  return { DATABASE_URL, APP_DATABASE_URL, AUTH_SECRET };
}

let cached: Env | undefined;

/** Validated on first access, then memoized. */
export function env(): Env {
  return (cached ??= loadEnv());
}
