import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Two clients, because the database enforces isolation by ROLE.
 *
 *   appDb    connects as ee_app, which owns nothing and is therefore subject to
 *            row level security. Every request-scoped query goes through
 *            `asUser()`, never directly.
 *
 *   ownerDb  connects as ee_owner, which owns the tables and is therefore
 *            EXEMPT from RLS. Reserved for migrations, webhook ingestion, and
 *            scheduled jobs that legitimately act across all tenants. Using it
 *            on a request path silently disables every policy.
 *
 * See MIGRATIONS.md for why the ownership split is what makes RLS real.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function makeClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

let _appDb: PrismaClient | undefined;
let _ownerDb: PrismaClient | undefined;

/** RLS-constrained client. Do not query this directly — use `asUser()`. */
export function appDb(): PrismaClient {
  return (_appDb ??= makeClient(required("APP_DATABASE_URL")));
}

/** RLS-exempt client. Justify every call site. */
export function ownerDb(): PrismaClient {
  return (_ownerDb ??= makeClient(required("DATABASE_URL")));
}

/**
 * Runs `fn` with the database's notion of "current user" set to `userId`, so
 * row level security policies resolve against them.
 *
 * The setting MUST be transaction-scoped. Prisma pools connections, so a
 * session-level `SET` would leak the identity to whichever request picks up
 * that socket next — one tenant reading another tenant's data, intermittently
 * and undetectably. The third argument to set_config is `is_local`, which ties
 * the value to this transaction and unsets it on commit or rollback.
 *
 *   const leases = await asUser(userId, (tx) => tx.lease.findMany());
 */
export async function asUser<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    // set_config takes text, so a malformed id would otherwise become a
    // silently-null current_user_id — which fails open into "see nothing"
    // rather than erroring, and is confusing to debug.
    throw new Error(`asUser: userId is not a UUID: ${userId}`);
  }

  return appDb().$transaction(
    async (tx) => {
      await tx.$executeRaw`select set_config('app.current_user_id', ${userId}, true)`;
      return fn(tx);
    },
    { timeout: options?.timeoutMs ?? 15_000 },
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Money is BigInt cents throughout the schema, and JSON.stringify throws on
 * BigInt. Convert at the API boundary rather than scattering Number() calls.
 */
export function centsToNumber(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new Error(`cents value exceeds safe integer range: ${cents}`);
  }
  return Number(cents);
}

export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  const remainder = abs % 100n;
  return `${negative ? "-" : ""}$${dollars.toLocaleString("en-US")}.${remainder
    .toString()
    .padStart(2, "0")}`;
}
