# Authentication

Email login codes, opaque sessions, and invite-only tenant creation.
`npm run auth:check` exercises all of it — 37 assertions, weighted toward the
properties that matter if they are wrong.

## Role separation is structural

There is no "sign up as a tenant" path, and no place to choose a role. A role is
a consequence of how the account came into being:

| Path | Produces | Entry point |
|---|---|---|
| `registerLandlord()` | landlord + new org + owner membership | self-serve |
| `acceptInvitation()` (org target) | landlord staff | emailed token |
| `acceptInvitation()` (lease target) | tenant | emailed token |

`app_user` still carries no role column. Roles live in `org_member` and
`lease_tenant`, so one identity could later hold both without a migration — the
single-role restriction is product policy, not schema.

A tenant cannot invite anyone, and this is not special-cased: `createInvitation`
requires the inviter to hold an `org_member` row for the org governing the
target, and tenants have none.

## Login codes

- 6 digits from `crypto.randomInt` (CSPRNG, unbiased — not `Math.random`)
- 10 minute TTL, single use, 5 verify attempts, then the code is burned
- 5 requests per address per hour, 20 per IP per hour
- A partial unique index permits one live code per address, so resending
  retires the previous one rather than leaving two valid

**Codes are hashed with HMAC-SHA256 keyed on `AUTH_SECRET`, not a bare digest.**
A 6-digit code is roughly 20 bits of entropy: a leaked table of plain SHA-256
hashes could be reversed in seconds. The keyed hash is useless without the
secret, which lives outside the database. Session and invitation tokens are 256
random bits, so those use a plain SHA-256 digest — the entropy does the work.

**No account enumeration.** `requestLoginCode` returns `{ accepted: true }`
whether or not the address has an account, and writes nothing when it does not.
Otherwise the endpoint would answer "is this person a tenant here?" for anyone
who asked. Every `verifyLoginCode` failure collapses to `invalid_or_expired`;
only `too_many_attempts` is distinguishable, because the user needs to be told
to start over.

Invited-but-unregistered addresses get no code. An invitation is redeemed with
its own emailed token, and that is what creates the account.

## Sessions

Opaque, server-side, 30 day TTL. Not JWTs: this application moves money, so
revocation must be immediate, and a stolen JWT stays valid until it expires with
nothing to delete. Only the token hash is stored. `last_seen_at` refreshes at
most every 5 minutes to avoid a write per request.

`revokeAllSessions(userId)` on email change, suspected compromise, and whenever
a user is removed from a lease or org — a session must not outlive the access
that justified it.

## Environment

`src/env.ts` validates at startup and refuses to run if `DATABASE_URL` and
`APP_DATABASE_URL` name the **same role**, since that means the app connects as
the table owner and every RLS policy is silently inert.

`AUTH_SECRET` must be at least 32 characters and **distinct per environment** —
sharing it would let a leak of one database compromise codes in the other.
Rotating it invalidates in-flight login codes, which is acceptable given the
10 minute TTL.

## Not built yet

- Email delivery. `requestLoginCode` takes a `deliver` callback; wire it to
  Resend or Postmark. The code must never reach the HTTP response.
- HTTP layer: cookie handling (`HttpOnly`, `Secure`, `SameSite=Lax`), CSRF, and
  turning `validateSession` into middleware.
- Idle timeout. Absolute expiry only today; add a `last_seen_at` check in
  `validateSession` if you want one.
- `purgeStaleAuthCodes()` and `purgeExpiredSessions()` exist but nothing
  schedules them.
