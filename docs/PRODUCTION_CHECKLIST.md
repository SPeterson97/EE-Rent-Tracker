# Production checklist

Everything that must be true before real tenants and real money touch this
system. Maintained as work progresses — items get added when a decision defers
something, and checked off when verified, not when merely done.

**Legend:** 🧍 needs you (an account, a signature, a bank, a decision) ·
💻 needs code · ✅ verified

Last updated: 2026-08-15 · Through commit `ef42062`

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

- [x] 💻 ~~Write RLS policies~~ — done in `0005_write_policies`. 49 policies;
      tenants may propose a split but only a landlord can approve one, enforced
      by the with-check rather than by a handler.
- [x] 💻 ~~Charge generation~~ — rent with proration, water on the service
      window, late fees with per-property grace and cap. Idempotent by
      construction.
- [ ] 🧍 **Schedule `runNightly()`** (cron, Vercel Cron, or pg_cron). The job
      exists and is safe to re-run; nothing triggers it.
- [x] 💻 ~~Alert on nightly-run failures~~ — emails `ALERT_EMAIL` with
      environment, duration, per-lease errors, and a redacted database host.
- [x] 💻 ~~Stripe Connect onboarding, ACH collection, webhook ingestion~~ —
      see docs/PAYMENTS.md. Tested against a fake gateway with real HMAC
      signatures; not yet exercised against Stripe's live test mode.
- [ ] 🧍 **Register the Stripe webhook endpoint** and subscribe to
      `payment_intent.*`, `charge.dispute.created`, `charge.refunded`,
      `account.updated`. Set `STRIPE_WEBHOOK_SECRET`.
- [ ] 🧍 **Run Stripe's ACH test account numbers end to end**, especially the
      failure and dispute ones — the reversal path is the one worth proving
      against the real API before real money moves.
- [x] 💻 ~~Scheduled jobs~~ — purges, deposit clock, and lease health checks
      run inside `runMaintenance()` as part of the nightly job.
- [x] 💻 ~~Notifications~~ — see docs/NOTIFICATIONS.md.
- [x] 💻 ~~CI~~ — `.github/workflows/ci.yml` provisions the two-role topology,
      migrates, and fails if any safety object goes missing.
- [ ] 🧍 **Confirm the first CI run is green on GitHub.** It has been simulated
      locally without a `.env` file but never executed on a runner.
- [ ] 💻 **Frontend** — Next.js, landlord surface first (decided 2026-08-14).

---

## 3. Should do, not strictly blocking

- [x] 💻 ~~Session idle timeout~~ — 14 days, configurable; idle sessions are
      revoked rather than merely rejected.
- [x] 💻 ~~Allocations sum to their charge~~ — deferred constraint trigger.
- [x] 💻 ~~Active-lease invariants~~ — reported by `checkLeaseHealth()` and
      surfaced through the alert email, deliberately not a constraint.
- [x] 💻 ~~Derive `return_due_on`~~ — from the jurisdiction ruleset when a
      tenancy ends.
- [ ] 💻 **CSV export** for your accountant / Schedule E.
- [ ] 💻 Audit trail for landlord config changes (who lowered the late fee?).
- [ ] 🧍 Decide the **partial-payment waterfall** and confirm it with counsel.
      Default is oldest-rent-first, fees-last; applying to fees first can
      manufacture a rent delinquency.

---

## 4. Verified ✅

Things already proven, so they don't need re-litigating.

- ✅ Migration applies clean from empty on both local Postgres 16 and Neon
- ✅ 123 safety objects present: 27 CHECK constraints, 49 RLS policies, 13
      partial indexes, 23 triggers, 11 functions, 1 `security_invoker` view
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
- ✅ 260 checks green locally: 69 billing, 47 HTTP, 37 auth, 37 Stripe, 31
      notification, 22 constraint, 11 data-access, 6 object counts
- ✅ Notifications cannot double-send — 8 concurrent sends of one key produce
      exactly one email
- ✅ Nightly job runs end to end: charges, late fees, reminders, purges, health
- ✅ A payment never credits the ledger until Stripe confirms settlement
- ✅ ACH reversal after settlement restores the debt without deleting history
- ✅ Webhook signatures verified against the raw body; tampered bodies rejected
- ✅ Duplicate webhook delivery cannot double-credit, including a different
      event id carrying the same settlement
- ✅ Charge generation is idempotent — running rent, late fees, and water
      generation twice produces exactly one charge each
- ✅ Late fees respect the property's local timezone, not the server's
- ✅ Allocations always reconcile to the charge exactly, including thirds
- ✅ Posted charges cannot be deleted; corrections must be offsetting entries

---

## 5. Known accepted risks

Decisions made deliberately, recorded so they are not rediscovered as bugs.

- **One role per account.** A person who is a landlord here and a tenant
  elsewhere needs a second email. The schema separates identity from
  membership, so lifting this is a UI change, not a migration.
- **`ee_owner` bypasses RLS by design.** Any code path using `ownerDb()` must
  justify itself. Currently: auth (pre-identity), webhook ingestion, jobs.
- **Stripe is verified against a fake, not live test mode.** The port is
  narrow and the fake models ACH's delayed settlement, but the live API has
  not been exercised — see the checklist item above.
- **Rate limiting is per-address and per-IP in the database.** Adequate at this
  scale; a distributed limiter would be needed at much higher volume.
- **Jurisdiction rules are reference data, not legal advice.** Several
  Pittsburgh entries are flagged `verify_with_counsel`.
