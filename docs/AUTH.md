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

## HTTP layer

`src/http/app.ts` exports `handle(request, socketAddress)` — a single
`Request → Response` function. That is the signature Next.js route handlers,
Hono, Bun, and Deno all speak, so mounting this later is an adapter rather than
a port. `src/http/server.ts` is a `node:http` adapter that exists so the API can
be run and tested today.

```
POST /auth/request-code    { email }                     -> 202 (always)
POST /auth/verify-code     { email, code }               -> 200 + cookies
POST /auth/register        { email, orgName }            -> 200 + cookies
POST /auth/accept-invite   { token }                     -> 200 + cookies
POST /auth/invitations     { email, leaseId | orgId }    -> 201  (auth required)
POST /auth/logout                                        -> 204  (auth required)
GET  /auth/me                                            -> 200  (auth required)
```

**Cookies.** `ee_session` is `HttpOnly`, `SameSite=Lax`, `Secure` in production.
Lax rather than Strict because Strict drops the cookie when a user arrives by
clicking a link in their email, which is the primary flow here. `ee_csrf` is
deliberately readable by JavaScript — the client has to echo it in
`X-CSRF-Token` for the double-submit check to mean anything.

**CSRF** is enforced on unsafe methods only when a session cookie is present.
Unauthenticated endpoints have no ambient authority to abuse. It runs before the
handler and before session lookup, so a forged request causes no side effects on
its way to a 403.

**Secrets never appear in responses.** Login codes go only to the email, and
invitation tokens only into the emailed link — API responses get logged, cached,
and screenshotted in places an inbox does not. Both are asserted in the suite.

**Client IP** comes from the socket unless `TRUST_PROXY=1`, in which case the
rightmost `X-Forwarded-For` entry is used. Trusting that header unconditionally
would let anyone defeat per-IP rate limits by inventing one, which is worse than
having no limit because it looks like it works.

## A trap worth remembering

The HTTP suite caught a real RLS gap: tenants could read their own lease but not
the `unit` it belonged to, because `unit_visible` was scoped to org membership.

It surfaced as `TypeError: Cannot read properties of null (reading 'label')`.
Prisma types a required relation as non-nullable, but **RLS filters rows after
the join**, so a missing policy makes a required relation come back `null` at
runtime. A permission problem shows up as a type error, nowhere near the cause.

Migration `0004_tenant_visibility` added the policies; `db/test/0003_rls.sql`
guards against regression. When adding any relation a tenant will traverse,
check the policy exists before trusting the types.
