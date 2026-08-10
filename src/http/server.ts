import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handle } from "./app.js";

/**
 * node:http adapter.
 *
 * Exists so the API can actually be run and integration-tested today. The real
 * logic lives in `handle()`, which takes a Web-standard Request — swapping this
 * for a Next.js route handler changes nothing above it.
 */

const MAX_BODY_BYTES = 256 * 1024;

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }

  const method = req.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers[key] = value;
  });

  // Several cookies are set on login; a plain iteration would collapse them
  // into one comma-joined header that browsers reject.
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;

  res.writeHead(response.status, headers);
  if (response.body) {
    res.end(Buffer.from(await response.arrayBuffer()));
  } else {
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null); // caller turns this into a 413
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

export function createHttpServer() {
  return createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        if (body === null) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
          return;
        }
        const response = await handle(toRequest(req, body), req.socket.remoteAddress ?? null);
        await writeResponse(response, res);
      } catch (error) {
        console.error("[server] failed to handle request:", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    })();
  });
}

const isEntrypoint = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");

if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 3000);
  createHttpServer().listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
}
