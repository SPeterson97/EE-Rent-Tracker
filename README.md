# EE Rent Tracker

Rent, utility, and payment tracking for small landlords. Multiple properties and
units, multiple tenants per unit splitting a shared balance, monthly water
rebilling, and automatic late fees.

## Documentation

| Doc | Covers |
|---|---|
| [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md) | **What must be true before going live** |
| [MIGRATIONS.md](MIGRATIONS.md) | Two-layer migrations, database roles, RLS |
| [docs/AUTH.md](docs/AUTH.md) | Login codes, sessions, invitations, HTTP layer |
| [docs/NEON_SETUP.md](docs/NEON_SETUP.md) | Connecting to Neon step by step |

## Local setup

See [MIGRATIONS.md](MIGRATIONS.md#local-setup). Briefly:

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb ee_rent_tracker && createdb ee_rent_tracker_shadow
export EE_OWNER_PASSWORD='...' EE_APP_PASSWORD='...'
for db in ee_rent_tracker ee_rent_tracker_shadow; do
  psql -d "$db" -v owner_password="$EE_OWNER_PASSWORD" \
       -v app_password="$EE_APP_PASSWORD" -v ON_ERROR_STOP=1 -f db/sql/0000_roles.sql
done
cp .env.example .env       # fill in
npm install && npx prisma generate && npm run db:migrate
```

## Commands

```bash
npm run dev          # HTTP server on :3000
npm run db:migrate   # apply migrations (never `prisma db push` — see MIGRATIONS.md)
npm run db:verify    # assert the safety layer survived
npm run db:seed      # two isolated orgs of fixtures
npm run db:test      # constraint rejections + RLS isolation (SQL)
npm run db:check     # data-access layer, incl. connection-leak test
npm run auth:check   # login codes, sessions, invitations
npm run http:check   # end-to-end HTTP
npm run typecheck
```

Add `ENV_FILE=.env.neon` to target another database. Do **not** `source` an env
file into your shell — see [docs/NEON_SETUP.md](docs/NEON_SETUP.md).

## Architecture notes

- **The database is built in two layers.** Prisma owns tables and columns;
  hand-written SQL owns CHECK constraints, triggers, partial indexes, views, and
  row level security — none of which Prisma can express. `prisma db push` would
  produce a database with none of it.
- **Isolation is enforced by database role.** The app connects as a non-owning
  role so RLS applies; migrations connect as the owner, which bypasses it.
- **The ledger is append-only.** Corrections and ACH returns post offsetting
  entries; a trigger rejects UPDATE and DELETE outright.
- **Money is `BigInt` cents.** Billing boundaries are dates, not timestamps,
  because "due on the 5th" is a calendar fact in the property's timezone.
- **HTTP is `Request → Response`.** Framework-agnostic, so mounting under
  Next.js later is an adapter rather than a port.
