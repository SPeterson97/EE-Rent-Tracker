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

Two roles, and the distinction is the entire basis of tenant isolation:

| Role | Used by | Owns tables | RLS |
|---|---|---|---|
| `ee_owner` | migrations, trusted server-side jobs | yes | **bypassed** |
| `ee_app` | the running application | no | **enforced** |

Postgres exempts a table's owner from that table's RLS policies. Neither role is
a superuser and neither has `BYPASSRLS` — `ee_owner`'s exemption comes purely
from ownership, which keeps it scoped to this schema.

The app connects as `ee_app` via `APP_DATABASE_URL`. Connecting as `ee_owner`
disables every policy **silently** — nothing errors, queries just start
returning other landlords' rows. Verified on this schema: with no user context
set, `ee_owner` sees 2 leases and `ee_app` sees 0.

### Creating them

Roles are cluster-wide rather than per-database, so this is a one-time bootstrap
step that cannot live in a Prisma migration. Run it **before** the first
migration, once per Postgres server:

```bash
export EE_OWNER_PASSWORD='...'   # not in git, not in .env.example
export EE_APP_PASSWORD='...'

psql -d ee_rent_tracker \
  -v owner_password="$EE_OWNER_PASSWORD" \
  -v app_password="$EE_APP_PASSWORD" \
  -v ON_ERROR_STOP=1 \
  -f db/sql/0000_roles.sql
```

The script is idempotent — existing roles are left alone, so it is safe to
re-run after adding a database. It creates both roles, transfers database
ownership to `ee_owner`, grants `ee_app` DML but explicitly **not** `CREATE` on
`public`, and sets default privileges so tables from future migrations are
reachable automatically. It ends by printing three assertions: both roles show
`superuser=f, bypasses_rls=f`, the database owner is `ee_owner`, and
`ee_app.can_create_objects` is `f`.

Run it against the **shadow database too** — Prisma needs `ee_owner` to own it:

```bash
psql -d ee_rent_tracker_shadow \
  -v owner_password="$EE_OWNER_PASSWORD" -v app_password="$EE_APP_PASSWORD" \
  -f db/sql/0000_roles.sql
```

### Why migrations must run as `ee_owner`

`ALTER DEFAULT PRIVILEGES` only applies to objects created by the role it was
declared for. Applying a migration as any other role produces tables that
`ee_app` has no grants on at all, and the app fails with permission errors that
look nothing like the actual cause.

### Rotating a password

The bootstrap script never overwrites an existing role's password. Do it
deliberately:

```sql
alter role ee_app password 'new-password';
```

Then update `APP_DATABASE_URL`. Existing pooled connections survive until they
are recycled, so expect a brief window where both work.

### Managed Postgres

On Neon, RDS, or similar you generally cannot create a true superuser, but you
do not need one — the provider's default role can create both of these. On
Supabase, reuse its existing `authenticated`/`service_role` split rather than
adding a third pair. What matters everywhere is that **the role the application
connects as does not own the tables**.

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
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"   # keg-only formula

createdb ee_rent_tracker && createdb ee_rent_tracker_shadow

# Roles — see "Creating them" above. Both databases.
export EE_OWNER_PASSWORD='...' EE_APP_PASSWORD='...'
for db in ee_rent_tracker ee_rent_tracker_shadow; do
  psql -d "$db" -v owner_password="$EE_OWNER_PASSWORD" \
       -v app_password="$EE_APP_PASSWORD" -v ON_ERROR_STOP=1 \
       -f db/sql/0000_roles.sql
done

cp .env.example .env    # replace CHANGEME with the passwords above
npm run db:migrate      # applies as ee_owner
npm run db:verify       # asserts all 57 safety objects are present
npm run db:seed         # two isolated orgs for manual poking
npm run db:test         # 22 constraint rejections + RLS isolation
```

Verified end to end on a fresh database: roles → migrate → all six object
counts `ok`, no views missing `security_invoker`.
