# Production checklist

Everything that must be true before real tenants and real money touch this
system. Maintained as work progresses — items get added when a decision defers
something, and checked off when verified, not when merely done.

**Legend:** 🧍 needs you (an account, a signature, a bank, a decision) ·
💻 needs code · ✅ verified

Last updated: 2026-08-12 · Through commit `c428723`

---

## 1. Blocking — only you can do these

### Secrets and accounts

- [ ] 🧍 **Rotate the `ee_app` password.** Currently a memorable string in
      `.env.neon`. `alter role ee_app password '<generated>'` then update
      `APP_DATABASE_URL`. Deadline is the first real tenant record, not launch.
- [ ] 🧍 **Resend account + verified sending domain.** Set `RESEND_API_KEY` and
      `MAIL_FROM`. Without these the console mailer is used, which refuses to
      run under `NODE_ENV=production` — so this fails loudly, not silently.
- [ ] 🧍 **Domain and `APP_BASE_URL`.** Invitation links are built from it; a
      wrong value emails unusable links.
- [ ] 🧍 **Stripe account + Connect enabled.** Needed before any payment work.
- [ ] 🧍 Confirm `AUTH_SECRET` in production is ≥32 chars and **distinct** from
      every other environment.
- [ ] 🧍 Set `NODE_ENV=production` — this is what turns on `Secure` cookies and
      the mailer guard.
- [ ] 🧍 Set `TRUST_PROXY=1` **only** if you terminate behind a proxy you
      control. Wrong either way is a real problem: unset behind a proxy breaks
      per-IP limits, set without one lets anyone forge their IP.

### Legal — Pennsylvania / Pittsburgh

- [ ] 🧍 **Have a PA landlord-tenant attorney review the deposit and late-fee
      defaults.** The 30-day return deadline carries **double damages** exposure
      for wrongful withholding. Cheap insurance relative to the risk.
- [ ] 🧍 **Open a separate escrow account** for security deposits at a regulated
      institution (required over $100), and record its name and address — you
      must disclose both to tenants. Commingling with rent income is the single
      most common way PA landlords lose a deposit dispute.
- [ ] 🧍 Plan for the **interest-bearing** requirement once a tenancy passes two
      years (interest is the tenant's; you may retain 1%/yr).
- [ ] 🧍 **Verify Pittsburgh rental registration** status with the city. The
      ordinance has been litigated and revised; `us-pa-pittsburgh.json` flags it
      `verify_with_counsel` rather than asserting it.
- [ ] 🧍 Confirm your lease language matches the app's late-fee config. PA sets
      no statutory cap, but a fee a court reads as a penalty is unenforceable.

### Operations

- [ ] 🧍 Confirm **Neon backups / point-in-time recovery** are on and test a
      restore. This is a financial ledger.
- [ ] 🧍 Error monitoring and alerting (nothing is wired up).
- [ ] 🧍 Decide who receives alerts for **failed ACH payments** — the highest
      operational-urgency event in the system.

---

## 2. Blocking — code still to be written

- [ ] 💻 **Write RLS policies.** Only `SELECT` policies exist, so `ee_app`
      cannot INSERT/UPDATE/DELETE on the 16 protected tables. Fail-closed and
      safe, but no feature that writes data can ship until these are authored
      per-endpoint.
- [ ] 💻 **Charge generation** — rent from `lease_rent_period`, water from
      entered bills, late fees on the property's grace period. Idempotency keys
      exist; the job does not.
- [ ] 💻 **Stripe Connect onboarding**, ACH collection, and webhook ingestion.
      `stripe_event` and the Connect columns are modelled; nothing calls Stripe.
- [ ] 💻 **Scheduled jobs.** `purgeStaleAuthCodes()` and
      `purgeExpiredSessions()` exist but nothing runs them. Same for the
      deposit 30-day reminder clock.
- [ ] 💻 **Notifications** — rent due, payment received, **payment failed**,
      late fee posted, deposit deadline approaching.
- [ ] 💻 **Frontend.** No UI exists; the API is headless today.
- [ ] 💻 **CI running `db:verify`.** Nothing currently prevents a migration
      landing without its layer-2 SQL, which would silently drop constraints,
      triggers, and RLS.

---

## 3. Should do, not strictly blocking

- [ ] 💻 Session **idle timeout** (absolute 30-day expiry only today).
- [ ] 💻 Enforce **allocations sum to their charge** — currently unconstrained.
- [ ] 💻 Enforce that an active lease has a **rent period and at least one
      tenant**; neither is currently required, and charge generation would
      silently produce nothing.
- [ ] 💻 Derive `security_deposit.return_due_on` from move-out + the
      jurisdiction's deadline instead of leaving it manual.
- [ ] 💻 **CSV export** for your accountant / Schedule E.
- [ ] 💻 Audit trail for landlord config changes (who lowered the late fee?).
- [ ] 🧍 Decide the **partial-payment waterfall** and confirm it with counsel.
      Default is oldest-rent-first, fees-last; applying to fees first can
      manufacture a rent delinquency.

---

## 4. Verified ✅

Things already proven, so they don't need re-litigating.

- ✅ Migration applies clean from empty on both local Postgres 16 and Neon
- ✅ 57+ safety objects present: 27 CHECK constraints, 18 RLS policies, 13
      partial indexes, 23 triggers, 9 functions, 1 `security_invoker` view
- ✅ Append-only ledger rejects UPDATE and DELETE, via SQL and via Prisma
- ✅ RLS isolates orgs; `ee_app` sees 0 rows with no user context
- ✅ Identity does not leak across pooled connections — 12 interleaved
      concurrent requests through Neon's real PgBouncer, zero contamination
- ✅ App refuses to start if `DATABASE_URL` and `APP_DATABASE_URL` name the same
      role (the misconfiguration that silently disables RLS)
- ✅ TLS is `verify-full`, not `require`
- ✅ No account enumeration; login codes and invite tokens never appear in an
      API response
- ✅ Tenants cannot invite anyone; landlords cannot invite into another org
- ✅ 47 HTTP + 37 auth + 22 constraint + 11 data-access checks green on both
      databases

---

## 5. Known accepted risks

Decisions made deliberately, recorded so they are not rediscovered as bugs.

- **One role per account.** A person who is a landlord here and a tenant
  elsewhere needs a second email. The schema separates identity from
  membership, so lifting this is a UI change, not a migration.
- **`ee_owner` bypasses RLS by design.** Any code path using `ownerDb()` must
  justify itself. Currently: auth (pre-identity), webhook ingestion, jobs.
- **Rate limiting is per-address and per-IP in the database.** Adequate at this
  scale; a distributed limiter would be needed at much higher volume.
- **Jurisdiction rules are reference data, not legal advice.** Several
  Pittsburgh entries are flagged `verify_with_counsel`.
