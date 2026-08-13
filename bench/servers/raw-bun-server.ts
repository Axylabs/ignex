#!/usr/bin/env bun
/**
 * bench/servers/raw-bun-server.ts — the raw `Bun.serve` baseline.
 *
 * Implements the SAME real-work endpoints the ignex compiled server exposes,
 * but with plain Bun / web primitives and zero framework code:
 *   POST /api/orders   — req.json() + a manual body-validation loop
 *   GET  /api/search   — new URL().searchParams iteration (many params)
 *   GET  /api/me       — cookie parsing + HMAC session-cookie verify
 *   GET  /api/reports/:id — HS256 JWT verification (Bearer)
 *   GET  /catalog      — string-concat HTML template render (120 items)
 *   GET  /api/big      — large JSON response, gzip when accepted
 *
 * This is the "native" target the AOT-compiled ignex server must beat.
 */
import { createHmac } from "node:crypto";
import { BENCH_SECRET, bigJson, catalogItems } from "../real-data";

const PORT = Number(process.env.PORT ?? 3101);

const catalog = catalogItems(120);
const big = bigJson(256);
const bigBytes = new TextEncoder().encode(big);
const bigGzip = Bun.gzipSync(bigBytes);

const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
const hmacBytes = (data: string): Buffer =>
  createHmac("sha256", BENCH_SECRET).update(data).digest();
/** Lowercase-hex HMAC-SHA256 (signed-cookie format). */
const hmacHex = (data: string): string => hmacBytes(data).toString("hex");
/** base64url HMAC-SHA256 (HS256 JWT signature format). */
const hmacB64url = (data: string): string => b64url(hmacBytes(data));

const verifyJwt = (token: string): boolean => {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return false;
  return hmacB64url(`${header}.${payload}`) === signature;
};

const verifySessionCookie = (value: string): string | null => {
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  return hmacHex(id) === signature ? id : null;
};

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });

const handleOrders = (req: Request): Promise<Response> =>
  req
    .json()
    .then((body) => {
      const record = body as { lineItems?: unknown[]; totalCents?: unknown };
      if (!Array.isArray(record.lineItems) || typeof record.totalCents !== "number") {
        return json({ ok: false, error: "invalid_order" }, { status: 400 });
      }
      for (const item of record.lineItems) {
        const li = item as { quantity?: unknown; unitPriceCents?: unknown };
        if (typeof li.quantity !== "number" || typeof li.unitPriceCents !== "number") {
          return json({ ok: false, error: "invalid_order" }, { status: 400 });
        }
      }
      return json({ ok: true, count: record.lineItems.length, total: record.totalCents });
    })
    .catch(() => json({ ok: false, error: "bad_json" }, { status: 400 }));

const handleSearch = (url: URL): Response => {
  let count = 0;
  let length = 0;
  for (const [k, v] of url.searchParams) {
    count += 1;
    length += k.length + v.length;
  }
  return json({ ok: true, params: count, decodedLength: length });
};

const handleMe = (req: Request): Response => {
  const header = req.headers.get("cookie") ?? "";
  const pairs = header.split(";");
  let sid: string | null = null;
  for (const part of pairs) {
    const eq = part.indexOf("=");
    const name = eq < 0 ? part.trim() : part.slice(0, eq).trim();
    const value = eq < 0 ? "" : part.slice(eq + 1).trim();
    if (name === "sid") sid = verifySessionCookie(value);
  }
  return json({ ok: true, cookies: pairs.length, sid });
};

const handleReports = (req: Request, url: URL): Response => {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!verifyJwt(token)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return json({ ok: true, report: url.pathname.split("/").pop() });
};

const handleCatalog = (): Response => {
  let html = "<ul>";
  for (const item of catalog) {
    html += `<li data-id="${item.id}"><h2>${item.name}</h2><span>$${item.price}</span><p>${item.description}</p></li>`;
  }
  html += "</ul>";
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

const handleBig = (req: Request): Response => {
  if ((req.headers.get("accept-encoding") ?? "").includes("gzip")) {
    return new Response(bigGzip, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
      },
    });
  }
  return new Response(big, { headers: { "content-type": "application/json; charset=utf-8" } });
};

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const { pathname } = url;

    if (method === "POST" && pathname === "/api/orders") return handleOrders(req);
    if (method === "GET" && pathname === "/api/search") return handleSearch(url);
    if (method === "GET" && pathname === "/api/me") return handleMe(req);
    if (method === "GET" && pathname.startsWith("/api/reports/")) return handleReports(req, url);
    if (method === "GET" && pathname === "/catalog") return handleCatalog();
    if (method === "GET" && pathname === "/api/big") return handleBig(req);
    if (method === "GET" && pathname === "/health") return json({ ok: true });

    return json({ ok: false, error: "not_found" }, { status: 404 });
  },
});

console.log(`raw-bun baseline listening on :${server.port}`);
