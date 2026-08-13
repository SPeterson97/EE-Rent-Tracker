# Billing

Rent generation, water rebilling, and late fees. Split into a pure core that
decides *what* should be charged and a thin wrapper that writes it.

```
src/billing/period.ts    calendar and timezone arithmetic   (pure)
src/billing/allocate.ts  splits, payment waterfall, fees    (pure)
src/billing/plan.ts      what to charge, given a snapshot   (pure)
src/billing/run.ts       load snapshot -> plan -> write     (database)
```

`npm run billing:check` — 69 assertions, most of which need no database.
`npm run billing:run [YYYY-MM-DD]` — the nightly job, dated for replay.

## Why pure functions with a thin job

Everything interesting is a function from a lease snapshot to intended charges.
That means proration, split math, grace periods, and DST boundaries are all
testable without a clock, a transaction, or a cron trigger. `run.ts` loads rows,
calls a planner, and writes the result — it holds no rules.

`generateRent(period)` takes the period explicitly rather than reading "now", so
a missed month can be re-run and tests do not depend on the calendar.

## Idempotency

Every generated charge carries a deterministic key:

```
rent:<leaseId>:2026-11
late_fee:<leaseId>:2026-11
water:<leaseId>:2026-10-01_2026-10-31
```

A unique constraint enforces it, so a double-fired cron, a retry after a
timeout, or two workers racing all produce **one** charge. The job treats the
resulting constraint violation as an expected outcome, not an error. Asserted by
running each generator twice and counting rows.

## Timezone

Due dates are calendar facts in the **property's** timezone. `late fee after the
5th` in Pittsburgh is not the same instant as in Denver, and generating from UTC
would levy fees hours early. `assessLateFees` converts `asOf` into each
property's local date before any comparison, via `Intl` so the IANA database and
DST transitions are handled properly.

The test that pins this: `2026-01-01T04:30:00Z` is still **2025-12-31** in
Pittsburgh, so it belongs to December's billing period — while being January in
UTC.

## Money splits

Weights combine the split plan with occupancy, so a mid-period move-in falls out
of the same arithmetic rather than needing a correction pass:

```
weight = shareBps × daysOccupied
```

Shares are floored, then every leftover cent goes to the tenant flagged
`absorbsRemainder`. Rounding each share independently drifts off the total;
floor-plus-absorber always reconciles exactly. $2000 split three ways is
66666 / 66666 / 66668.

## Payment waterfall

The ledger is lease-level and joint-and-several, so payments are not tied to
particular charges. `applyCredits` answers "is September rent actually paid?" by
applying credits **oldest first, fees last**.

Fees last is a legal position, not a preference: applying payments to fees first
turns a tenant who paid their rent into a rent delinquent on paper, which can
manufacture grounds for eviction. Some jurisdictions prohibit it.

## Late fees

Levied when a period's rent still has an outstanding balance after the grace
period. Configurable per property — flat or percent, cap, grace days, and
whether unpaid water counts. Pennsylvania sets no statutory cap, so the config
allows none; the jurisdiction content warns against unreasonable amounts.

Fees never compound: a late fee is computed on unpaid **rent** (and optionally
water), never on other fees.

## Correcting a mistake

Generated charges cannot be deleted. The append-only trigger blocks it — even
`charge.deleteMany()` fails, because deleting a charge nulls
`ledger_entry.charge_id`, which is an UPDATE. This is deliberate.

To correct a charge posted in error, **post an offsetting reversal entry**. The
history stays intact and the balance is right. The billing suite asserts the
deletion is refused, and its own teardown has to disable the trigger as the
owner role — something no production code should ever do.

## Scheduling

`runNightly()` generates the current month's rent and assesses late fees for the
current **and previous** month — a fee becomes due after the grace period, which
routinely lands in the following month.

Nothing schedules it yet. See the production checklist.
