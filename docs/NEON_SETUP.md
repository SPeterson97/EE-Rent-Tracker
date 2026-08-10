# Connecting to Neon

Step-by-step setup via [console.neon.tech](https://console.neon.tech). Assumes
local development already works (see MIGRATIONS.md).

Console labels shift occasionally; steps are described by function so they stay
findable. The commands are exact.

---

## Decide first: is Neon your dev database, or your deploy target?

This changes what you provision.

| | Neon as deploy target **(recommended)** | Neon as dev database |
|---|---|---|
| Local Postgres | keep for `migrate dev` | not needed |
| Shadow database on Neon | **not needed** | required |
| Prisma command against Neon | `migrate deploy` only | `migrate dev` |

`prisma migrate dev` is the only command needing a shadow database, and you only
run it while authoring migrations. Keeping that local means Neon holds one
database instead of two, and you never point a schema-diffing command at
production. The rest of this guide assumes the recommended column, with the
extra shadow step marked **(dev-on-Neon only)**.

---

## 1. Create the project

1. Sign in at console.neon.tech.
2. **Create project**. Set:
   - **Name** — `ee-rent-tracker`
   - **Postgres version** — **16**, matching local (17 is fine; just keep them equal so behaviour matches)
   - **Region** — closest to where the app will be deployed, not to you. Cross-region latency on every query is worse than a slow deploy.
3. Neon creates a database named `neondb` and a role named `neondb_owner`.

You can rename the database or create `ee_rent_tracker` under **Databases →
New Database**. Using the default `neondb` is fine — nothing in this project
depends on the name. The commands below use `neondb`; substitute if you renamed.

**(dev-on-Neon only)** Also create a second database named
`ee_rent_tracker_shadow` under **Databases → New Database**.

## 2. Copy both connection strings

On the project dashboard, find the **Connection string** / **Connect** widget.
There is a **connection pooling** toggle. You need **both** forms:

| Toggle | Host looks like | Use as |
|---|---|---|
| **off** (direct) | `ep-cool-name-123456.us-east-2.aws.neon.tech` | `DATABASE_URL` — migrations |
| **on** (pooled) | `ep-cool-name-123456-**pooler**.us-east-2.aws.neon.tech` | base for `APP_DATABASE_URL` — runtime |

Both end in `?sslmode=require`. Keep it.

> Migrations **must** use the direct host. PgBouncer in transaction mode breaks
> DDL, advisory locks, and prepared statements.

## 3. Create the `ee_app` role

The connection string Neon just gave you is `neondb_owner` — the role that
**owns every table**. Postgres exempts table owners from row level security, so
an application connecting with it silently reads every landlord's data. You need
a second, non-owning role.

> **Do not use the Neon console's SQL Editor for this.** `db/sql/0000_roles.sql`
> uses psql meta-commands (`\gexec`, `\if`, `\echo`) that only the `psql` client
> understands. The web editor runs plain SQL and will error.

Run it from your machine with `psql` pointed at Neon. Use the **direct** host:

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
cd ~/Documents/Projects/ee-rent-tracker

export NEON_DIRECT='postgresql://neondb_owner:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require'
export EE_APP_PASSWORD='pick-a-strong-password'

psql "$NEON_DIRECT" \
  -v owner_role=neondb_owner \
  -v app_password="$EE_APP_PASSWORD" \
  -v ON_ERROR_STOP=1 \
  -f db/sql/0000_roles.sql
```

`owner_password` is omitted deliberately — `neondb_owner` already exists and the
script skips creating a role that is present.

**Expected output.** You will see this NOTICE, and it is fine:

```
NOTICE:  Could not set role attributes (needs superuser). Expected on managed
Postgres — the verification query at the end of this script confirms what matters.
```

Neon does not grant superuser, so `ALTER ROLE … NOBYPASSRLS` is skipped. Neon
does not grant `BYPASSRLS` by default either, so the end state is correct. What
matters is the four assertions the script prints last:

```
 rolname       | superuser | bypasses_rls | can_login
 ee_app        | f         | f            | t          <- bypasses_rls MUST be f
 neondb_owner  | f         | f            | t

 database | owner              <- must NOT be ee_app
 neondb   | neondb_owner

 can_create_objects | can_use_schema
 f                  | t                <- ee_app must not create objects

 Tables owned by ee_app (MUST be empty):
 (0 rows)
```

If `bypasses_rls` is `t` for `ee_app`, stop — isolation will not work.

**(dev-on-Neon only)** Repeat against the shadow database, swapping `/neondb`
for `/ee_rent_tracker_shadow` in the URL.

## 4. Write `.env.neon`

`.gitignore` already excludes `.env.*` except `.env.example`, so this stays out
of git.

```bash
cat > .env.neon <<'EOF'
# DIRECT host (no -pooler) — migrations and psql
DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require"

# POOLED host (-pooler) as ee_app — the running application
APP_DATABASE_URL="postgresql://ee_app:APP_PASSWORD@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"

# Only needed if you run `prisma migrate dev` against Neon
# SHADOW_DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/ee_rent_tracker_shadow?sslmode=require"
EOF
```

Three things to get right, each of which fails quietly rather than loudly:

- `DATABASE_URL` uses `neondb_owner` on the **direct** host
- `APP_DATABASE_URL` uses `ee_app` on the **pooled** host
- the two roles are genuinely different — this is the whole isolation mechanism

## 5. Apply migrations

```bash
ENV_FILE=.env.neon npm run db:migrate
```

Both migrations should apply. `migrate deploy` never needs a shadow database.

## 6. Verify — do not skip this

```bash
ENV_FILE=.env.neon npm run db:verify
```

Expect all six `ok` and an empty "Views missing security_invoker":

```
 app schema functions    |  7 |  7 | ok
 check constraints       | 26 | 26 | ok
 partial indexes         | 11 | 11 | ok
 RLS policies            | 16 | 16 | ok
 tables with RLS enabled | 16 | 16 | ok
 triggers                | 22 | 22 | ok
```

Then prove isolation actually works on Neon, using seed data:

```bash
ENV_FILE=.env.neon npm run db:seed
ENV_FILE=.env.neon npm run db:check
```

The assertion that matters most is `querying appDb directly returns 0 rows`. If
it returns 2, `APP_DATABASE_URL` is pointed at an owner role and RLS is inert.

Clean up the seed rows when you are done (they are test fixtures, not real data):

```bash
psql "$NEON_DIRECT" -c "truncate app_user, org cascade;"
```

## 7. Runtime adapter

`src/db.ts` uses `@prisma/adapter-pg` over TCP, which is right for a long-lived
Node server. If you deploy to an environment without raw TCP sockets — Vercel
Edge, Cloudflare Workers — switch to `@prisma/adapter-neon`, which speaks Neon's
serverless driver over WebSockets:

```bash
npm install @prisma/adapter-neon @neondatabase/serverless
```

`asUser()` is unchanged either way; it is what carries `app.current_user_id`
safely through the pooler.

---

## Things that will bite you

**Scale to zero.** Neon idles compute after inactivity, so the first connection
after a quiet period pays a cold start of a second or more. This matters for the
nightly charge-generation and late-fee jobs — give them generous connect
timeouts rather than tight ones. It also means the first `psql` after a break
feels slow; that is normal.

**Do not run `prisma db push`.** It applies layer 1 only, producing a database
with no CHECK constraints, no triggers, and no RLS. See MIGRATIONS.md.

**Branches.** Neon can branch a database copy-on-write, which is genuinely
useful for testing a migration against production-shaped data. A branch gets its
own endpoint hostname, so it needs its own `.env.<branch>` file. Roles are
inherited by the branch, so `ee_app` comes along with it.

**Rotating the app password.** `alter role ee_app password '...'` via psql, then
update `APP_DATABASE_URL`. Pooled connections survive until recycled, so both
work briefly.
