# Migrations

The database is built in **two layers**. Prisma owns the first; it cannot
express the second.

| Layer | Source | Contains |
|---|---|---|
| 1 — shape | `prisma/schema.prisma` | tables, columns, enums, relations, ordinary indexes |
| 2 — safety | `db/sql/*.sql` | CHECK constraints, triggers, partial indexes, views, RLS |

Measured on the initial migration, layer 2 is **57 objects Prisma emits nothing
for**: 26 CHECK constraints, 16 RLS policies, 11 partial indexes, 2 triggers, 6
functions, and 1 view.

> **Never run `prisma db push` on this project.** It applies layer 1 only. The
> result is a database where the ledger is freely editable, split percentages
> need not sum to 100%, a lease can have two active split plans, and every
> landlord can read every other landlord's data.

## Adding a migration

```bash
# 1. Edit prisma/schema.prisma, then generate the SQL WITHOUT applying it.
npx prisma migrate dev --create-only --name <descriptive_name>

# 2. Write the matching layer-2 SQL in db/sql/<NNNN>_<name>.sql
#    and append it to the generated migration:
cat db/sql/<NNNN>_<name>.sql >> prisma/migrations/<timestamp>_<name>/migration.sql

# 3. Apply and verify.
npm run db:migrate
npm run db:verify
```

## Checklist for every new table

Prisma will not do any of these for you.

- [ ] `CHECK` constraints for every invariant (amount signs, date ordering, enum-dependent required fields)
- [ ] Partial unique indexes for "only one active/default/live X" rules
- [ ] `alter table … enable row level security`
- [ ] A `SELECT` policy scoping the table to `app.visible_lease_ids()` or `app.user_org_ids()`
- [ ] `grant` to `ee_app` (covered by `alter default privileges`, but confirm)
- [ ] An idempotency key with a `unique` constraint if any background job writes to it
- [ ] Money columns are `BigInt` cents; billing boundaries are `@db.Date`, not timestamps

Any view added later **must** be created `WITH (security_invoker = true)`.
Without it the view runs as its owner and silently bypasses RLS on every table
it reads.

## Roles

Two roles, and the distinction is load-bearing:

| Role | Used by | RLS |
|---|---|---|
| `ee_owner` | migrations, trusted server-side jobs | **bypassed** (owns the tables) |
| `ee_app` | the running application | **enforced** |

The app connects as `ee_app` via `APP_DATABASE_URL`. Connecting as `ee_owner`
disables every policy — verified: with no user context, `ee_owner` sees 2 leases
and `ee_app` sees 0.

Because Prisma pools connections, the user context must be set **per
transaction**, never per connection, or it leaks to the next request that
reuses the socket:

```ts
export function asUser<T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    // third argument `true` scopes the setting to this transaction
    await tx.$executeRaw`select set_config('app.current_user_id', ${userId}, true)`;
    return fn(tx);
  });
}
```

## Known gap: write policies

Only `SELECT` policies exist so far. Under RLS that means `ee_app` currently
**cannot** INSERT, UPDATE, or DELETE on the 16 protected tables — writes fail
closed, which is safe but incomplete.

Add `INSERT`/`UPDATE` policies alongside the endpoints that need them. Until
then, mutations go through a service path connecting as `ee_owner` that performs
its own authorization checks.

## Local setup

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb ee_rent_tracker && createdb ee_rent_tracker_shadow
# create ee_owner / ee_app roles, then:
cp .env.example .env    # fill in real passwords
npm run db:migrate
npm run db:seed         # two isolated orgs for manual poking
npm run db:test         # constraint rejection + RLS isolation suites
```
