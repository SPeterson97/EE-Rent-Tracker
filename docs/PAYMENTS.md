# Payments

Stripe Connect onboarding, ACH collection, and webhook ingestion.
`npm run stripe:check` — 37 assertions, no API keys and no network.

## The rule everything else follows

**Initiating a payment does not credit the ledger.** ACH takes 3-5 business days
to settle and can fail *after* appearing to succeed. The only place a payment
becomes a ledger credit is the `payment_intent.succeeded` webhook.

`initiatePayment` always records the payment as `processing`, even if Stripe
reports success immediately, so there is exactly one code path that credits the
ledger rather than two that must agree.

## Connect

Express accounts: the landlord clicks a button in the app, Stripe hosts the KYC
and bank collection, and they return. This application never sees government
identifiers or bank credentials.

Money moves as a **destination charge** — funds settle into the landlord's
connected account, which keeps Stripe as the money transmitter rather than us.

`initiatePayment` refuses with `payouts_disabled` when the landlord has not
finished onboarding. Taking a tenant's money into an account that cannot pay out
is far worse than declining up front.

## Webhook idempotency, three layers deep

Stripe redelivers on any non-2xx, delivers out of order, and can deliver the
same event twice on success. Three independent defences:

1. **`stripe_event.id` is the primary key** — a redelivery collides on insert
   and never reaches a handler.
2. **Handlers check current state** — a `processing` event arriving after
   `succeeded` is ignored rather than walking the status backwards.
3. **A partial unique index** permits one `payment` ledger entry per payment.
   Layers 1 and 2 are read-then-write and lose a race; the index does not.

The suite tests all three, including a *different* event id carrying the same
settlement — which layer 1 does not catch.

## Reversal after settlement

Consumer ACH can be returned as unauthorized up to roughly 60 days after the
money appeared to arrive. Handled as `charge.dispute.created` /
`charge.refunded`:

- the payment moves to `reversed`
- an offsetting **positive** ledger entry restores the debt
- it points at the original credit via `reverses_entry_id`

The original credit is never deleted. "Paid, then returned" stays visible, which
is exactly what a tenant will dispute months later.

## Webhook endpoint

`POST /stripe/webhook` is unauthenticated by design — Stripe cannot present a
session. The signature is the authentication, verified against the **raw** body;
parsing and re-serializing changes the bytes and invalidates the HMAC. It is the
one CSRF-exempt route, and the exemption is safe because a signature is strictly
stronger than a cookie the browser sends automatically.

It returns 200 once the signature verifies, even if a handler failed. A non-2xx
makes Stripe retry, and an unhandleable event would loop forever; the event is
stored with `processError` and an operator alert is sent instead.

## Testing without keys

`FakeStripeGateway` implements the same narrow port as the live adapter and
models what matters: idempotency keys return the *original* intent, and ACH
lands in `processing`, never `succeeded`. Webhook signatures in the suite are
real HMACs, so verification is genuinely exercised — including a tampered body.

## Going live

1. Stripe account with Connect enabled; set `STRIPE_SECRET_KEY`.
2. Register the webhook endpoint, subscribe to `payment_intent.processing`,
   `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `charge.dispute.created`, `charge.refunded`, `account.updated`; set
   `STRIPE_WEBHOOK_SECRET`.
3. Verify with Stripe's ACH test account numbers, including the failure ones —
   the reversal path is the one worth exercising for real.
