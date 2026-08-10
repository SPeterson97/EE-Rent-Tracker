-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "created_ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- SAFETY LAYER — see db/sql/0003_session.sql (source of truth)
-- ===========================================================================

-- 0003_session.sql — layer 2 for the session table.
--
-- No RLS here, deliberately, and for the same reason as app_user, auth_code,
-- and invitation: session lookup happens BEFORE any user identity is known.
-- A policy keyed on app.current_user_id could never match, because resolving
-- the session is what establishes that value in the first place. These tables
-- are reached only by the service role during authentication.

alter table "session"
  add constraint session_expires_after_creation check (expires_at > created_at);

-- Hot path: validating a bearer token on every request. Partial, because
-- expired and revoked rows are dead weight in the index.
create index session_live
  on "session" (expires_at)
  where revoked_at is null;

-- "Sign out everywhere" and the active-sessions list.
create index session_live_by_user
  on "session" (user_id)
  where revoked_at is null;

-- Attach the updated_at trigger. This is the same catalog-driven block as
-- 0002_updated_at.sql, inlined rather than \i-included: migrations are executed
-- by Prisma's engine, not psql, so meta-commands like \i are not available.
do $$
declare
  t record;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name  = 'updated_at'
       and tb.table_type  = 'BASE TABLE'
     order by c.table_name
  loop
    if not exists (
      select 1 from pg_trigger
       where tgname = t.table_name || '_touch_updated_at'
         and not tgisinternal
    ) then
      execute format(
        'create trigger %I before update on public.%I
           for each row execute function app.touch_updated_at()',
        t.table_name || '_touch_updated_at', t.table_name);
    end if;
  end loop;
end $$;
