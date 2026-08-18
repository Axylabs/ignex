/**
 * @fileoverview Comprehensive smoke test for the generated app server.
 *
 * Boots `packages/app/dist/__server.js` as a child process, waits for it to
 * accept connections, then exercises EVERY route and user-facing flow of the
 * shipped app: static/constant routes, env accessors, i18n negotiation, the
 * job queue, server-rendered templates, sessions, the OpenAPI spec, multipart
 * uploads (+ upload→download round-trip), file serving (ranges, ETag/304,
 * traversal guard), product validation, the JWT auth flow, router semantics
 * (404/405/OPTIONS/HEAD), CORS, security headers, gzip compression, and a
 * concurrency sanity check. Exits non-zero if the server fails to boot or any
 * assertion fails. Used by `bun run smoke` (and `bun run smoke:fallback` with
 * `IGNEX_NATIVE=off`) and the CI pipeline.
 *
 * Requires the app to be built first (`bun run build`).
 *
 * Env overrides:
 *   PORT — server port (default 3000; must match the generated server)
 *   BASE — base URL to hit (default `https://127.0.0.1:${PORT}` — the app
 *          serves HTTPS over an auto-generated dev cert by default)
 *
 * Global fetch is patched to disable TLS verification so the self-signed dev
 * certificate is accepted; pointing BASE at an `http://` URL still works (the
 * TLS option is ignored for plain HTTP).
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Accept the auto-generated self-signed dev certificate for all fetches below.
if (!(globalThis.fetch as unknown as { __ignexSmokeTls?: boolean }).__ignexSmokeTls) {
  const originalFetch = globalThis.fetch;
  const patched = ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch(input, { ...init, tls: { rejectUnauthorized: false } })) as typeof fetch;
  (patched as unknown as { __ignexSmokeTls?: boolean }).__ignexSmokeTls = true;
  globalThis.fetch = patched;
}

const PORT = Number(process.env.PORT ?? 3000);
const BASE = process.env.BASE ?? `https://127.0.0.1:${PORT}`;
const APP_DIR = new URL("../packages/app/", import.meta.url).pathname;
const UPLOAD_DIR = join(APP_DIR, "uploads");

/** Seed file content (10 bytes — used by the range/ETag/304 assertions). */
const SAMPLE = "0123456789";
/** Distinct bytes used by the upload round-trip check. */
const UPLOAD_CONTENT = "hello-upload-content";

/* ------------------------------------------------------------------ *
 * Tiny test runner (dependency-free; PASS/FAIL lines + summary).      *
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${label}`);
  } catch (err) {
    failed += 1;
    failures.push(label);
    console.log(`FAIL ${label} → ${(err as Error).message}`);
  }
}

function expectStatus(res: Response, expected: number): Response {
  if (res.status !== expected) {
    throw new Error(`status ${res.status} (expected ${expected})`);
  }
  return res;
}

function expectHeader(res: Response, name: string, expected: string | null): void {
  const value = res.headers.get(name);
  if (value !== expected) {
    throw new Error(
      `header ${name} = ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`,
    );
  }
}

function expectHeaderContains(res: Response, name: string, needle: string): void {
  const value = res.headers.get(name);
  if (value === null || !value.includes(needle)) {
    throw new Error(
      `header ${name} = ${JSON.stringify(value)} (expected to contain ${JSON.stringify(needle)})`,
    );
  }
}

type Json = Record<string, unknown>;

async function expectJson(res: Response, status: number): Promise<Json> {
  expectStatus(res, status);
  const text = await res.text();
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(`expected a JSON body, got: ${JSON.stringify(text.slice(0, 200))}`);
  }
}

async function expectText(res: Response, status: number, needle: string): Promise<string> {
  expectStatus(res, status);
  const text = await res.text();
  if (!text.includes(needle)) {
    throw new Error(
      `body does not contain ${JSON.stringify(needle)}; got: ${JSON.stringify(text.slice(0, 200))}`,
    );
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Boot the generated server (same strategy as before).                *
 * ------------------------------------------------------------------ */

const proc = spawn("bun", ["dist/__server.js"], {
  cwd: APP_DIR,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let procOutput = "";
proc.stdout.on("data", (d: Buffer) => (procOutput += d.toString()));
proc.stderr.on("data", (d: Buffer) => (procOutput += d.toString()));

/** Poll the health endpoint until the server accepts connections. */
const waitForServer = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200) return;
    } catch {
      // server not up yet — keep polling
    }
    await delay(150);
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms`);
};

/** Remove the runtime `uploads/` directory (idempotent, best-effort). */
const cleanupUploads = async (): Promise<void> => {
  try {
    await rm(UPLOAD_DIR, { recursive: true, force: true });
  } catch {
    // best-effort — never let cleanup mask a real failure
  }
};

let booted = false;
try {
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(join(UPLOAD_DIR, "sample.txt"), SAMPLE);
  await waitForServer(10_000);
  booted = true;

  /* ---------- static / constant routes ---------- */
  await check("GET / (constant route) → 200 + exact body", async () => {
    const res = await fetch(`${BASE}/`);
    expectStatus(res, 200);
    // The constant string is serialized as JSON, so the raw body is quoted.
    const parsed = JSON.parse(await res.text()) as unknown;
    if (parsed !== "ignex zero-runtime API") {
      throw new Error(`body ${JSON.stringify(parsed)}`);
    }
  });

  await check("GET /health → 200 + JSON ok", async () => {
    const body = await expectJson(await fetch(`${BASE}/health`), 200);
    if (body.status !== "ok") throw new Error(`status field ${JSON.stringify(body.status)}`);
  });

  await check("GET /hello (named-export) → 200 + body", async () => {
    await expectText(await fetch(`${BASE}/hello`), 200, "Hello World");
  });

  await check("GET /openapi → 200 text/html + api-reference", async () => {
    const res = await fetch(`${BASE}/openapi`);
    expectStatus(res, 200);
    expectHeaderContains(res, "content-type", "text/html");
    await expectText(res, 200, "api-reference");
  });

  /* ---------- env ---------- */
  await check("GET /env → 200 typed config + requestId", async () => {
    const body = await expectJson(await fetch(`${BASE}/env`), 200);
    if (body.port !== PORT) throw new Error(`port ${JSON.stringify(body.port)} (expected ${PORT})`);
    if (!Array.isArray(body.features)) {
      throw new Error(`features not an array: ${JSON.stringify(body.features)}`);
    }
    if (typeof body.requestId !== "string" || body.requestId.length === 0) {
      throw new Error(`requestId missing: ${JSON.stringify(body.requestId)}`);
    }
  });

  /* ---------- i18n ---------- */
  await check("GET /i18n default → en", async () => {
    const body = await expectJson(await fetch(`${BASE}/i18n`), 200);
    if (body.locale !== "en") throw new Error(`locale ${JSON.stringify(body.locale)}`);
    if (typeof body.message !== "string" || !body.message.includes("Hello")) {
      throw new Error(`message ${JSON.stringify(body.message)}`);
    }
  });

  await check("GET /i18n Accept-Language: es → Hola", async () => {
    const res = await fetch(`${BASE}/i18n`, { headers: { "accept-language": "es" } });
    const body = await expectJson(res, 200);
    if (body.locale !== "es") throw new Error(`locale ${JSON.stringify(body.locale)}`);
    if (typeof body.message !== "string" || !body.message.includes("Hola")) {
      throw new Error(`message ${JSON.stringify(body.message)}`);
    }
  });

  await check("GET /i18n Accept-Language: fr → Bonjour", async () => {
    const res = await fetch(`${BASE}/i18n`, { headers: { "accept-language": "fr" } });
    const body = await expectJson(res, 200);
    if (typeof body.message !== "string" || !body.message.includes("Bonjour")) {
      throw new Error(`message ${JSON.stringify(body.message)}`);
    }
  });

  await check("GET /i18n unknown locale → en fallback", async () => {
    const res = await fetch(`${BASE}/i18n`, { headers: { "accept-language": "xx-YY" } });
    const body = await expectJson(res, 200);
    if (body.locale !== "en") throw new Error(`locale ${JSON.stringify(body.locale)}`);
  });

  await check("GET /i18n ?name= reflected", async () => {
    const body = await expectJson(await fetch(`${BASE}/i18n?name=Ada`), 200);
    if (body.message !== "Hello Ada") throw new Error(`message ${JSON.stringify(body.message)}`);
  });

  /* ---------- jobs ---------- */
  await check("GET /jobs → enqueued demo job + queue state", async () => {
    const body = await expectJson(await fetch(`${BASE}/jobs`), 200);
    if (body.enqueued !== "demo") throw new Error(`enqueued ${JSON.stringify(body.enqueued)}`);
    if (typeof body.pending !== "number" || typeof body.running !== "number") {
      throw new Error(`queue state ${JSON.stringify(body)}`);
    }
  });

  /* ---------- page (templates) ---------- */
  await check("GET /page → 200 text/html + rendered title", async () => {
    const res = await fetch(`${BASE}/page`);
    expectHeaderContains(res, "content-type", "text/html");
    await expectText(res, 200, "Ignex demo");
  });

  await check("GET /page?name=Ada → name reflected", async () => {
    await expectText(await fetch(`${BASE}/page?name=Ada`), 200, "Ada");
  });

  /* ---------- session ---------- */
  await check("GET /session → sets sid cookie (HttpOnly)", async () => {
    const res = await fetch(`${BASE}/session`);
    expectStatus(res, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    if (!setCookie.includes("sid=")) throw new Error(`set-cookie ${JSON.stringify(setCookie)}`);
    if (!setCookie.includes("HttpOnly")) throw new Error(`set-cookie missing HttpOnly`);
  });

  await check("GET /session visits increment across requests", async () => {
    const first = await fetch(`${BASE}/session`);
    const firstBody = (await expectJson(first, 200)) as { visits?: number; isNew?: boolean };
    if (firstBody.visits !== 1) throw new Error(`first visits ${JSON.stringify(firstBody.visits)}`);
    if (firstBody.isNew !== true) throw new Error(`first isNew ${JSON.stringify(firstBody.isNew)}`);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const second = await fetch(`${BASE}/session`, { headers: { cookie } });
    const secondBody = (await expectJson(second, 200)) as { visits?: number; isNew?: boolean };
    if (secondBody.visits !== 2)
      throw new Error(`second visits ${JSON.stringify(secondBody.visits)}`);
    if (secondBody.isNew !== false)
      throw new Error(`second isNew ${JSON.stringify(secondBody.isNew)}`);
  });

  /* ---------- openapi ---------- */
  await check("GET /openapi.json → 200 valid spec + no-store", async () => {
    const res = await fetch(`${BASE}/openapi.json`);
    expectHeaderContains(res, "content-type", "application/json");
    expectHeader(res, "cache-control", "no-store");
    const body = (await expectJson(res, 200)) as { openapi?: string; paths?: unknown };
    if (typeof body.openapi !== "string")
      throw new Error(`openapi field ${JSON.stringify(body.openapi)}`);
    if (typeof body.paths !== "object" || body.paths === null) throw new Error("paths missing");
  });

  await check("GET /openapi.json gzip when accept-encoding", async () => {
    const res = await fetch(`${BASE}/openapi.json`, { headers: { "accept-encoding": "gzip" } });
    expectStatus(res, 200);
    expectHeader(res, "content-encoding", "gzip");
    const text = await res.text(); // undici auto-decompresses → must still parse
    JSON.parse(text);
  });

  /* ---------- upload + round-trip ---------- */
  await check("POST /upload multipart file → 200 metadata", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([UPLOAD_CONTENT], { type: "text/plain" }), "notes.txt");
    const body = (await expectJson(
      await fetch(`${BASE}/upload`, { method: "POST", body: fd }),
      200,
    )) as {
      ok?: boolean;
      size?: number;
      type?: string;
      path?: string;
    };
    if (body.ok !== true) throw new Error(`ok ${JSON.stringify(body.ok)}`);
    if (body.size !== UPLOAD_CONTENT.length) throw new Error(`size ${JSON.stringify(body.size)}`);
    // Bun reports form file types as `text/plain;charset=utf-8`.
    if (typeof body.type !== "string" || !body.type.includes("text/plain")) {
      throw new Error(`type ${JSON.stringify(body.type)}`);
    }
    if (typeof body.path !== "string" || !body.path.startsWith("/files/")) {
      throw new Error(`path ${JSON.stringify(body.path)}`);
    }
  });

  await check("POST /upload without a file → 400", async () => {
    const fd = new FormData();
    const body = await expectJson(await fetch(`${BASE}/upload`, { method: "POST", body: fd }), 400);
    if (typeof body.error !== "string") throw new Error(`error ${JSON.stringify(body.error)}`);
  });

  await check("upload → GET /files/<path> round-trip", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([UPLOAD_CONTENT], { type: "text/plain" }), "roundtrip.txt");
    const created = (await expectJson(
      await fetch(`${BASE}/upload`, { method: "POST", body: fd }),
      200,
    )) as {
      path?: string;
    };
    const path = created.path ?? "";
    const res = await fetch(`${BASE}${path}`);
    expectStatus(res, 200);
    expectHeader(res, "accept-ranges", "bytes");
    expectHeaderContains(res, "content-disposition", "attachment");
    const text = await res.text();
    if (text !== UPLOAD_CONTENT) throw new Error(`body ${JSON.stringify(text)}`);
  });

  /* ---------- files (sendFile) ---------- */
  await check("GET /files/sample.txt → 200 + headers", async () => {
    const res = await fetch(`${BASE}/files/sample.txt`);
    expectStatus(res, 200);
    expectHeader(res, "accept-ranges", "bytes");
    expectHeaderContains(res, "content-type", "text/plain");
    expectHeaderContains(res, "cache-control", "public");
    if (!res.headers.get("etag")) throw new Error("missing etag");
    if (!res.headers.get("last-modified")) throw new Error("missing last-modified");
    const text = await res.text();
    if (text !== SAMPLE) throw new Error(`body ${JSON.stringify(text)}`);
  });

  await check("GET /files/sample.txt Range 0-3 → 206 partial", async () => {
    const res = await fetch(`${BASE}/files/sample.txt`, { headers: { range: "bytes=0-3" } });
    expectStatus(res, 206);
    expectHeader(res, "content-range", "bytes 0-3/10");
    const text = await res.text();
    if (text !== "0123") throw new Error(`body ${JSON.stringify(text)}`);
  });

  await check("GET /files/sample.txt invalid Range → 416", async () => {
    const res = await fetch(`${BASE}/files/sample.txt`, { headers: { range: "bytes=999999-" } });
    expectStatus(res, 416);
  });

  await check("GET /files/sample.txt If-None-Match → 304", async () => {
    const first = await fetch(`${BASE}/files/sample.txt`);
    const etag = first.headers.get("etag") ?? "";
    const res = await fetch(`${BASE}/files/sample.txt`, { headers: { "if-none-match": etag } });
    expectStatus(res, 304);
  });

  await check("GET /files/missing.txt → 404", async () => {
    expectStatus(await fetch(`${BASE}/files/missing.txt`), 404);
  });

  await check("GET /files traversal guard → 403", async () => {
    const res = await fetch(`${BASE}/files/..%2fetc%2fpasswd`);
    expectStatus(res, 403);
  });

  /* ---------- products ---------- */
  await check("GET /products/:id → 200 echo", async () => {
    const body = (await expectJson(await fetch(`${BASE}/products/42`), 200)) as {
      product?: { id?: string };
    };
    if (body.product?.id !== "42") throw new Error(`body ${JSON.stringify(body)}`);
  });

  await check("GET /products/42/extra → 404", async () => {
    expectStatus(await fetch(`${BASE}/products/42/extra`), 404);
  });

  await check("POST /products/add valid body → 200 echo", async () => {
    const body = (await expectJson(
      await fetch(`${BASE}/products/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "widget" }),
      }),
      200,
    )) as { created?: boolean };
    if (body.created !== true) throw new Error(`created ${JSON.stringify(body.created)}`);
  });

  await check("POST /products/add malformed JSON → 400", async () => {
    expectStatus(
      await fetch(`${BASE}/products/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
      400,
    );
  });

  /* ---------- native body validation (validate-and-ack) ---------- */
  // /api/orders-ack declares a body schema and never reads ctx.body — the
  // compiled server's per-route native stack validates the raw bytes (native
  // when the addon is present, JS fallback otherwise). Same status contract.
  await check("POST /api/orders-ack valid body → 200 ack", async () => {
    const body = (await expectJson(
      await fetch(`${BASE}/api/orders-ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "o1", quantity: 2, totalCents: 100 }),
      }),
      200,
    )) as { ok?: boolean };
    if (body.ok !== true) throw new Error(`ack ${JSON.stringify(body)}`);
  });

  await check("POST /api/orders-ack schema-invalid body → 422", async () => {
    const res = await fetch(`${BASE}/api/orders-ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "o1", quantity: 0, totalCents: -5 }),
    });
    if (res.status !== 422) throw new Error(`status ${res.status} (expected 422)`);
    const body = (await res.json()) as { status?: number; details?: { on?: string } };
    if (body.status !== 422 || body.details?.on !== "body") {
      throw new Error(`validation error envelope ${JSON.stringify(body)}`);
    }
  });

  await check("POST /api/orders-ack non-JSON body → 400", async () => {
    const res = await fetch(`${BASE}/api/orders-ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    if (res.status !== 400) throw new Error(`status ${res.status} (expected 400)`);
    const body = (await res.json()) as { code?: string };
    if (body.code !== "BODY_PARSE_ERROR") {
      throw new Error(`body parse error envelope ${JSON.stringify(body)}`);
    }
  });

  /* ---------- auth (JWT flow: access + refresh tokens) ---------- */
  await check("POST /auth/login valid → 200 { accessToken, refreshToken }", async () => {
    const body = (await expectJson(
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      }),
      200,
    )) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
    if (
      typeof body.accessToken !== "string" ||
      body.accessToken.split(".").length !== 3 ||
      typeof body.refreshToken !== "string" ||
      body.refreshToken.length < 16 ||
      body.expiresIn !== 900
    ) {
      throw new Error(`login body ${JSON.stringify(body)}`);
    }
  });

  await check("POST /auth/login wrong password → 401", async () => {
    expectStatus(
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      }),
      401,
    );
  });

  await check("POST /auth/login malformed body → 400", async () => {
    expectStatus(
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad",
      }),
      400,
    );
  });

  await check("GET /auth/me without token → 401", async () => {
    expectStatus(await fetch(`${BASE}/auth/me`), 401);
  });

  await check("GET /auth/me with garbage token → 401", async () => {
    expectStatus(
      await fetch(`${BASE}/auth/me`, { headers: { authorization: "Bearer garbage" } }),
      401,
    );
  });

  await check("login → GET /auth/me round-trip", async () => {
    const login = (await expectJson(
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      }),
      200,
    )) as { accessToken?: string };
    const body = (await expectJson(
      await fetch(`${BASE}/auth/me`, {
        headers: { authorization: `Bearer ${login.accessToken}` },
      }),
      200,
    )) as { user?: { sub?: string; roles?: string[] } };
    if (body.user?.sub !== "admin" || !body.user?.roles?.includes("admin")) {
      throw new Error(`user ${JSON.stringify(body.user)}`);
    }
  });

  await check("POST /auth/register → 201, then login as the new user", async () => {
    const username = "alice";
    const password = "wonderland";
    const reg = (await expectJson(
      await fetch(`${BASE}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
      201,
    )) as { accessToken?: string; refreshToken?: string };
    if (typeof reg.accessToken !== "string" || typeof reg.refreshToken !== "string") {
      throw new Error(`register body ${JSON.stringify(reg)}`);
    }
    expectStatus(
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
      200,
    );
  });

  await check("POST /auth/refresh with valid token → 200 working access token", async () => {
    const login = (await expectJson(
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      }),
      200,
    )) as { refreshToken?: string };
    const fresh = (await expectJson(
      await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: login.refreshToken }),
      }),
      200,
    )) as { accessToken?: string; expiresIn?: number };
    if (
      typeof fresh.accessToken !== "string" ||
      fresh.accessToken.split(".").length !== 3 ||
      fresh.expiresIn !== 900
    ) {
      throw new Error(`refresh body ${JSON.stringify(fresh)}`);
    }
    const me = (await expectJson(
      await fetch(`${BASE}/auth/me`, {
        headers: { authorization: `Bearer ${fresh.accessToken}` },
      }),
      200,
    )) as { user?: { sub?: string } };
    if (me.user?.sub !== "admin") {
      throw new Error(`refreshed token user ${JSON.stringify(me.user)}`);
    }
  });

  await check("POST /auth/refresh with garbage token → 401", async () => {
    expectStatus(
      await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "garbage" }),
      }),
      401,
    );
  });

  await check("POST /auth/logout revokes the refresh token (refresh → 401)", async () => {
    const login = (await expectJson(
      await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "secret" }),
      }),
      200,
    )) as { refreshToken?: string };
    expectStatus(
      await fetch(`${BASE}/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: login.refreshToken }),
      }),
      200,
    );
    expectStatus(
      await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: login.refreshToken }),
      }),
      401,
    );
  });

  /* ---------- router / plugins ---------- */
  await check("GET unknown route → 404", async () => {
    expectStatus(await fetch(`${BASE}/missing-route`), 404);
  });

  await check("POST /health → 405 + Allow", async () => {
    const res = await fetch(`${BASE}/health`, { method: "POST", body: "x" });
    expectStatus(res, 405);
    expectHeaderContains(res, "allow", "GET");
  });

  await check("OPTIONS /health → 204", async () => {
    expectStatus(await fetch(`${BASE}/health`, { method: "OPTIONS" }), 204);
  });

  await check("HEAD /health → 200 empty body", async () => {
    const res = await fetch(`${BASE}/health`, { method: "HEAD" });
    expectStatus(res, 200);
    if ((await res.text()) !== "") throw new Error("HEAD body not empty");
  });

  await check("CORS preflight → 204 + allow-origin", async () => {
    const res = await fetch(`${BASE}/health`, {
      method: "OPTIONS",
      headers: { origin: "http://example.com", "access-control-request-method": "GET" },
    });
    expectStatus(res, 204);
    // Native castrum CORS owns preflight and echoes the allowed origin.
    expectHeader(res, "access-control-allow-origin", "http://example.com");
  });

  await check("CORS actual request → wildcard allow-origin", async () => {
    const res = await fetch(`${BASE}/health`, { headers: { origin: "http://example.com" } });
    expectStatus(res, 200);
    // OK-path CORS is served by Bun's default-header sink (`*` — equivalent to
    // the origin echo for non-credentialed requests).
    expectHeader(res, "access-control-allow-origin", "*");
  });

  await check("security headers applied", async () => {
    const res = await fetch(`${BASE}/health`);
    expectStatus(res, 200);
    expectHeader(res, "x-frame-options", "DENY");
    expectHeader(res, "x-content-type-options", "nosniff");
    expectHeader(res, "referrer-policy", "no-referrer");
    // HSTS is deliberately HTTPS-only — never sent on plain HTTP.
    expectHeader(res, "strict-transport-security", null);
  });

  await check(
    "global middleware: x-request-id (plugin) + x-ignex-middleware (lifecycle)",
    async () => {
      const res = await fetch(`${BASE}/health`);
      expectStatus(res, 200);
      // Custom `IgnexPlugin` (onRequest/onResponse) — see src/middleware/request-id.ts.
      const requestId = res.headers.get("x-request-id");
      if (!requestId || requestId.length < 8) {
        throw new Error(`x-request-id ${JSON.stringify(requestId)}`);
      }
      // Global lifecycle `afterHandle` hook — see src/middleware/log-requests.ts.
      expectHeader(res, "x-ignex-middleware", "true");
    },
  );

  /* ---------- robustness ---------- */
  await check("20 concurrent GET /health all 200", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${BASE}/health`)));
    for (const res of responses) expectStatus(res, 200);
  });
} catch (err) {
  failed += 1;
  failures.push("(harness)");
  console.error(`smoke harness error: ${(err as Error).message}`);
} finally {
  proc.kill("SIGTERM");
  await delay(400);
  if (proc.exitCode === null) proc.kill("SIGKILL");
  await cleanupUploads();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("failed checks:");
    for (const label of failures) console.error(`  - ${label}`);
    if (booted) console.error(procOutput || "(no server output)");
  }
  process.exit(failed > 0 ? 1 : 0);
}
