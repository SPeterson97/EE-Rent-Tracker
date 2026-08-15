/**
 * End-to-end HTTP suite. Run with:  npm run http:check
 *
 * Boots a real server on an ephemeral port and drives it with fetch, so cookie
 * handling, CSRF, and status codes are exercised the way a browser would.
 */
import type { AddressInfo } from "node:net";
import { ownerDb } from "./db.js";
import { purgeTestData } from "./testing/cleanup.js";
import { CapturingMailer, setMailer } from "./email/mailer.js";
import { createHttpServer } from "./http/server.js";

const SUFFIX = "@httpcheck.test";
const mail = new CapturingMailer();

let failures = 0;
let checks = 0;
let base = "";

function check(label: string, ok: boolean, detail = "") {
  checks++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** Minimal cookie jar, so the suite behaves like a browser session. */
class Jar {
  private jar = new Map<string, string>();

  absorb(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; jar?: Jar; csrf?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; response: Response }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.jar) {
    const cookie = options.jar.header();
    if (cookie) headers["cookie"] = cookie;
  }
  if (options.csrf) headers["x-csrf-token"] = options.csrf;

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  options.jar?.absorb(response);

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, response };
}

function codeFromLastEmail(): string {
  const m = mail.last();
  return /\b(\d{6})\b/.exec(m?.text ?? "")?.[1] ?? "";
}

async function cleanup() {
  await purgeTestData(SUFFIX);
}

async function main() {
  setMailer(mail);
  await cleanup();

  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // -------------------------------------------------------------------
  section("routing and hardening");

  check("health responds", (await call("GET", "/health")).status === 200);
  check("unknown path is 404", (await call("GET", "/nope")).status === 404);

  const wrongMethod = await call("GET", "/auth/request-code");
  check("wrong method is 405", wrongMethod.status === 405);
  check("...with an Allow header", wrongMethod.response.headers.get("allow") === "POST");

  const health = await call("GET", "/health");
  check("nosniff header set", health.response.headers.get("x-content-type-options") === "nosniff");
  check("responses are no-store", health.response.headers.get("cache-control") === "no-store");

  const noJson = await call("POST", "/auth/request-code", { headers: { "content-type": "text/plain" } });
  check("non-JSON body rejected", noJson.status === 400);

  // -------------------------------------------------------------------
  section("registration issues cookies correctly");

  const alice = new Jar();
  const reg = await call("POST", "/auth/register", {
    jar: alice,
    body: { email: `alice${SUFFIX}`, orgName: "HTTP Check LLC", displayName: "Alice" },
  });
  check("register returns 200", reg.status === 200, `got ${reg.status}`);

  const setCookies = reg.response.headers.getSetCookie();
  const sessionCookie = setCookies.find((c) => c.startsWith("ee_session="));
  const csrfCookieHeader = setCookies.find((c) => c.startsWith("ee_csrf="));
  check("session cookie is HttpOnly", !!sessionCookie?.includes("HttpOnly"));
  check("session cookie is SameSite=Lax", !!sessionCookie?.includes("SameSite=Lax"));
  check("CSRF cookie is NOT HttpOnly", !!csrfCookieHeader && !csrfCookieHeader.includes("HttpOnly"));
  check("both cookies sent separately", setCookies.length === 2, `${setCookies.length} headers`);
  check("csrfToken returned in body", typeof reg.body?.csrfToken === "string");

  const dupe = await call("POST", "/auth/register", {
    body: { email: `alice${SUFFIX}`, orgName: "Impostor" },
  });
  check("duplicate registration is 409", dupe.status === 409);

  // -------------------------------------------------------------------
  section("authenticated requests and CSRF");

  const me = await call("GET", "/auth/me", { jar: alice });
  check("me returns the user", me.body?.user?.email === `alice${SUFFIX}`);
  check("me reports landlord", me.body?.isLandlord === true);
  check("me reports not a tenant", me.body?.isTenant === false);

  const anon = await call("GET", "/auth/me");
  check("me without a session is 401", anon.status === 401);

  const csrf = alice.get("ee_csrf")!;
  const noCsrf = await call("POST", "/auth/logout", { jar: alice });
  check("state-changing request without CSRF header is 403", noCsrf.status === 403);

  const badCsrf = await call("POST", "/auth/logout", { jar: alice, csrf: "wrong-value" });
  check("wrong CSRF token is 403", badCsrf.status === 403);

  // -------------------------------------------------------------------
  section("login by emailed code");

  mail.clear();
  const unknown = await call("POST", "/auth/request-code", { body: { email: `ghost${SUFFIX}` } });
  check("unknown address still returns 202", unknown.status === 202);
  check("...and sends no email", mail.sent.length === 0);

  const req = await call("POST", "/auth/request-code", { body: { email: `alice${SUFFIX}` } });
  check("known address returns 202", req.status === 202);
  check("...and sends exactly one email", mail.sent.length === 1);
  check(
    "code is never in the HTTP response",
    !JSON.stringify(req.body).match(/\d{6}/),
    JSON.stringify(req.body),
  );
  check("code is not in the subject line", !/\d{6}/.test(mail.last()?.subject ?? ""));

  const code = codeFromLastEmail();
  check("email contains a 6-digit code", /^\d{6}$/.test(code));

  const badCode = await call("POST", "/auth/verify-code", {
    body: { email: `alice${SUFFIX}`, code: "000000" },
  });
  check("wrong code is 401", badCode.status === 401);

  const loggedIn = new Jar();
  const verified = await call("POST", "/auth/verify-code", {
    jar: loggedIn,
    body: { email: `alice${SUFFIX}`, code },
  });
  check("correct code is 200", verified.status === 200, `got ${verified.status}`);
  check("...and sets a session", !!loggedIn.get("ee_session"));

  const replay = await call("POST", "/auth/verify-code", {
    body: { email: `alice${SUFFIX}`, code },
  });
  check("code cannot be replayed over HTTP", replay.status === 401);

  // -------------------------------------------------------------------
  section("invitations end to end");

  const meAgain = await call("GET", "/auth/me", { jar: loggedIn });
  const orgId = meAgain.body.orgs[0].id;

  const property = await ownerDb().property.create({
    data: {
      orgId,
      name: "HTTP Check Property",
      line1: "1 Test St",
      city: "Pittsburgh",
      region: "PA",
      postalCode: "15224",
    },
  });
  const unit = await ownerDb().unit.create({ data: { propertyId: property.id, label: "2C" } });
  const lease = await ownerDb().lease.create({
    data: { unitId: unit.id, status: "active", startsOn: new Date("2026-01-01") },
  });

  mail.clear();
  const liveCsrf = loggedIn.get("ee_csrf")!;
  const invited = await call("POST", "/auth/invitations", {
    jar: loggedIn,
    csrf: liveCsrf,
    body: { email: `tam${SUFFIX}`, leaseId: lease.id },
  });
  check("landlord can create an invitation", invited.status === 201, `got ${invited.status}`);
  check("invitation email sent", mail.sent.length === 1);
  check(
    "token is not in the API response",
    !JSON.stringify(invited.body).includes("token"),
    JSON.stringify(invited.body),
  );

  const inviteToken = /token=([A-Za-z0-9_-]+)/.exec(mail.last()?.text ?? "")?.[1] ?? "";
  check("token is in the email link", inviteToken.length > 20);

  const anonInvite = await call("POST", "/auth/invitations", {
    body: { email: `x${SUFFIX}`, leaseId: lease.id },
  });
  check("unauthenticated invite is 401", anonInvite.status === 401);

  const tam = new Jar();
  const accepted = await call("POST", "/auth/accept-invite", {
    jar: tam,
    body: { token: inviteToken, displayName: "Tam" },
  });
  check("accepting the invite is 200", accepted.status === 200, `got ${accepted.status}`);
  check("...and returns tenant role", accepted.body?.role === "tenant");

  const tamMe = await call("GET", "/auth/me", { jar: tam });
  check("tenant reports isTenant", tamMe.body?.isTenant === true);
  check("tenant reports NOT landlord", tamMe.body?.isLandlord === false);
  check("tenant sees exactly one lease", tamMe.body?.leases?.length === 1);
  check("tenant sees no orgs", tamMe.body?.orgs?.length === 0);

  const reused = await call("POST", "/auth/accept-invite", { body: { token: inviteToken } });
  check("invite token cannot be reused", reused.status === 410);

  const tenantInvite = await call("POST", "/auth/invitations", {
    jar: tam,
    csrf: tam.get("ee_csrf")!,
    body: { email: `friend${SUFFIX}`, leaseId: lease.id },
  });
  check("tenant cannot invite anyone", tenantInvite.status === 403, `got ${tenantInvite.status}`);

  // -------------------------------------------------------------------
  section("logout");

  const out = await call("POST", "/auth/logout", { jar: loggedIn, csrf: liveCsrf });
  check("logout succeeds with CSRF", out.status === 204, `got ${out.status}`);
  check("cookies cleared", !loggedIn.get("ee_session"));

  const afterLogout = await call("GET", "/auth/me", { jar: loggedIn });
  check("session no longer works", afterLogout.status === 401);

  // -------------------------------------------------------------------
  await cleanup();
  server.close();

  console.log(
    failures === 0
      ? `\nAll ${checks} HTTP checks passed.\n`
      : `\n${failures} of ${checks} HTTP checks FAILED.\n`,
  );
  await ownerDb().$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
