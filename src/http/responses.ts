/**
 * JSON response helpers with security headers applied uniformly, so no single
 * handler can forget them.
 */

const BASE_HEADERS: Record<string, string> = {
  // Responses are JSON; stop a browser guessing otherwise.
  "x-content-type-options": "nosniff",
  // Authenticated data must never sit in a shared cache.
  "cache-control": "no-store",
  // Invitation and reset URLs carry tokens in the query string; do not hand
  // them to third-party hosts via the Referer header.
  "referrer-policy": "same-origin",
};

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return Response.json(body, {
    status: init.status ?? 200,
    headers: { ...BASE_HEADERS, ...(init.headers ?? {}) },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

export function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, { status: 400 });
}

export function unauthorized(): Response {
  return json(
    { error: "unauthorized", message: "Sign in to continue." },
    { status: 401 },
  );
}

export function forbidden(message = "You do not have access to that."): Response {
  return json({ error: "forbidden", message }, { status: 403 });
}

export function notFound(): Response {
  return json({ error: "not_found", message: "Not found." }, { status: 404 });
}

export function methodNotAllowed(allowed: string[]): Response {
  return json(
    { error: "method_not_allowed" },
    { status: 405, headers: { allow: allowed.join(", ") } },
  );
}

/**
 * Last line of defence. Logs the real cause and returns an opaque body — stack
 * traces and database errors routinely leak schema details and identifiers.
 */
export function internalError(error: unknown): Response {
  console.error("[http] unhandled error:", error);
  return json(
    { error: "internal_error", message: "Something went wrong." },
    { status: 500 },
  );
}
