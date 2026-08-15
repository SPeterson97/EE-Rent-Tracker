# Notifications

Email for the events that matter, keyed so nothing sends twice.
`npm run notifications:check` — 31 assertions.

| Event | Recipient | Trigger |
|---|---|---|
| `rent_due` | each tenant | 5, 1, and 0 days before, from the posted charge |
| `payment_received` | the payer | `payment_intent.succeeded` webhook |
| `payment_failed` | the payer | failure or post-settlement return |
| `late_fee_posted` | every tenant on the lease | when the fee is generated |
| `deposit_deadline` | org owners | 14, 7, 3, 1 days before the statutory deadline |

## Dedupe

Every send claims a `dedupe_key` in `notification_log` **before** the mail is
attempted, guarded by a unique constraint. Sending first and recording after
would double-send whenever the process died in between — and a duplicate "your
payment failed" is worse than a missing one.

The suite fires 8 concurrent sends of one key and asserts exactly one email.

Delivery failures leave the row claimed with an `error` set, so a retry storm
cannot flood an inbox. Unsent rows are visible through the
`notification_pending` partial index for manual replay.

## Keys encode the event, not the moment

- `rent_due:<chargeId>:<userId>:<daysUntil>` — one per horizon, so the 5-day and
  1-day reminders both send, but neither repeats
- `payment_failed:<paymentId>:declined|returned` — a decline and a
  post-settlement return are materially different messages and must both reach
  the tenant
- `deposit_deadline:<depositId>:<daysRemaining>` — escalates rather than repeats

## Details that matter

**Tenants see their own share.** Rent reminders use the per-tenant allocation,
not the charge total. Telling someone they owe $2,100 when their share is $840
generates more support mail than it prevents.

**A returned ACH reads differently from a decline.** A tenant whose transfer was
returned three weeks later believes they are paid up; the message says the
payment initially went through and the balance has been adjusted back.

**Notifications never throw.** Every event function catches and logs. A failed
email must not roll back the money movement that triggered it — which is also
why receipts are sent *after* the transaction commits.

**The deposit warning cites the exposure.** Missing PA's 30-day window forfeits
the right to withhold anything and risks double damages, so the email says so
rather than being a neutral reminder.

## Maintenance run

`runMaintenance()` runs inside the nightly job, after charges exist:

- sets `return_due_on` from the jurisdiction ruleset when a tenancy ends
- sends rent reminders and deposit warnings
- purges spent login codes and expired sessions
- runs `checkLeaseHealth()`

Health issues ride the same alert path as errors. A lease with no rent period or
no tenants bills nothing and would otherwise fail silently — it is a check
rather than a constraint because a lease must exist before tenants and rent can
be attached to it.
