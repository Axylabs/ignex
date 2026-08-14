/**
 * bench/compare/servers/elysia-server.ts — Elysia comparison participant.
 *
 * Ported from the rust project's `bench/servers/elysia-server.ts`: same route
 * contract, but implemented with Elysia primitives — `@elysia/cors` for CORS,
 * `onAfterHandle` for security headers, TypeBox schema validation for the body
 * (automatic 422), and streaming body echo.
 */

import { cors } from "@elysia/cors";
import { Elysia, t } from "elysia";
import {
  type ApiOk,
  CORS_CONFIG,
  PORTS,
  RATE_LIMIT_CONFIG,
  rateLimitCheck,
  SECURITY_HEADERS,
} from "../shared";

const userBodySchema = t.Object(
  {
    id: t.Number(),
    name: t.String({ minLength: 1, maxLength: 256 }),
    email: t.Optional(t.String()),
    active: t.Optional(t.Boolean()),
    tags: t.Optional(t.Array(t.String(), { maxItems: 20 })),
  },
  { additionalProperties: false },
);

/** Shared write handler: Elysia has already parsed + validated `body`. */
const usersWriteHandler = ({ set, body, query, cookie }: any) => {
  const cookies: Record<string, string> = {};
  for (const [key, val] of Object.entries(cookie)) {
    cookies[key] = (val as { value?: unknown } | undefined)?.value
      ? String((val as { value?: unknown }).value)
      : String(val ?? "");
  }
  const result: ApiOk = {
    ok: true,
    requestId: set.headers["X-Request-Id"] as string,
    path: "/api/users",
    query: query as Record<string, string | string[]>,
    cookies,
    body,
  };
  return result;
};

const app = new Elysia({ serve: { port: PORTS.elysia } }) // ── Security headers ──
  .onAfterHandle(({ set }) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) set.headers[k] = v;
  })
  // ── CORS via plugin ──
  .use(
    cors({
      origin: [...CORS_CONFIG.allowOrigin],
      methods: [...CORS_CONFIG.allowMethods],
      allowedHeaders: [...CORS_CONFIG.allowHeaders],
      exposeHeaders: [...CORS_CONFIG.exposeHeaders],
      credentials: CORS_CONFIG.allowCredentials,
      maxAge: CORS_CONFIG.maxAge,
    }),
  )
  // ── Request ID + rate-limit guard ──
  .onBeforeHandle(({ request, set }) => {
    const requestId = crypto.randomUUID();
    set.headers["X-Request-Id"] = requestId;

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      "127.0.0.1";
    const now = Date.now();
    const rl = rateLimitCheck(ip, now);
    set.headers["RateLimit-Limit"] = String(RATE_LIMIT_CONFIG.limit);
    set.headers["RateLimit-Remaining"] = String(rl.remaining);
    set.headers["RateLimit-Reset"] = String(Math.ceil(rl.resetMs / 1000));
    if (!rl.allowed) {
      const retrySecs = Math.ceil((rl.resetMs - now) / 1000);
      set.headers["Retry-After"] = String(retrySecs);
      set.status = 429;
      return {
        ok: false,
        error: {
          code: "rate_limited",
          message: "Too Many Requests",
          retry_after_ms: rl.resetMs - now,
        },
      };
    }
  })
  // ── GET /health ──
  .get("/health", ({ set }) => {
    const body: ApiOk = {
      ok: true,
      requestId: set.headers["X-Request-Id"] as string,
      path: "/health",
      query: {},
      cookies: {},
    };
    return body;
  })
  // ── GET /api/users ──
  .get("/api/users", ({ set, query, cookie }) => {
    const cookies: Record<string, string> = {};
    for (const [key, val] of Object.entries(cookie)) {
      cookies[key] = (val as { value?: unknown } | undefined)?.value
        ? String((val as { value?: unknown }).value)
        : String(val ?? "");
    }
    const body: ApiOk = {
      ok: true,
      requestId: set.headers["X-Request-Id"] as string,
      path: "/api/users",
      query: query as Record<string, string | string[]>,
      cookies,
    };
    return body;
  })
  // ── POST/PUT/PATCH /api/users — Elysia TypeBox schema validation ──
  .post("/api/users", usersWriteHandler, { body: userBodySchema })
  .put("/api/users", usersWriteHandler, { body: userBodySchema })
  .patch("/api/users", usersWriteHandler, { body: userBodySchema })
  // ── POST /api/echo — stream body directly ──
  .post("/api/echo", async ({ request, set }) => {
    const requestedContentType = request.headers.get("content-type") ?? "application/octet-stream";
    set.headers["Content-Type"] = requestedContentType;
    return request.body;
  })
  // ── GET /api/cookies ──
  .get("/api/cookies", ({ set, cookie }) => {
    const cookies: Record<string, string> = {};
    for (const [key, val] of Object.entries(cookie)) {
      cookies[key] = (val as { value?: unknown } | undefined)?.value
        ? String((val as { value?: unknown }).value)
        : String(val ?? "");
    }
    const body: ApiOk = {
      ok: true,
      requestId: set.headers["X-Request-Id"] as string,
      path: "/api/cookies",
      query: {},
      cookies,
    };
    return body;
  })
  // ── 404 / validation fallbacks ──
  .onError(({ code, set }) => {
    if (code === "NOT_FOUND") {
      set.status = 404;
      return {
        ok: false,
        error: { code: "not_found", message: "Route not found" },
      };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      return {
        ok: false,
        error: {
          code: "schema_validation_failed",
          message: "Request body failed schema validation",
        },
      };
    }
    set.status = 500;
    return {
      ok: false,
      error: { code: "internal_error", message: "Internal server error" },
    };
  });

app.listen(PORTS.elysia);
console.log(`[elysia] listening on :${PORTS.elysia}`);
