/**
 * bench/compare/servers/bun-server.ts — raw `Bun.serve` comparison baseline.
 *
 * Ported from the rust project's `bench/servers/bun-server.ts`: same route
 * contract, same shared helpers, zero framework code. Uses Bun's native
 * `routes` router (SIMD route matching) and Bun primitives (`req.json()`,
 * `req.cookies`, `crypto.randomUUID()`).
 */
import {
  type ApiError,
  type ApiOk,
  buildHeaders,
  cookiesToRecord,
  corsHeaders,
  getClientIp,
  MAX_BODY_BYTES,
  PORTS,
  parseQuery,
  RATE_LIMIT_CONFIG,
  rateLimitCheck,
  SECURITY_HEADERS,
  validateUserBody,
} from "../shared";

/** Rate-limit guard shared across routes — returns a 429 `Response` when
 * over the (effectively-disabled) limit, otherwise the rate-limit headers. */
function checkRateLimit(
  req: Request,
  server: unknown,
): { allowed: true; headers: Record<string, string> } | Response {
  const ip = getClientIp(req, server);
  const now = Date.now();
  const rl = rateLimitCheck(ip, now);
  const requestId = crypto.randomUUID();

  const rlHeaders: Record<string, string> = {
    "RateLimit-Limit": String(RATE_LIMIT_CONFIG.limit),
    "RateLimit-Remaining": String(rl.remaining),
    "RateLimit-Reset": String(Math.ceil(rl.resetMs / 1000)),
    "X-Request-Id": requestId,
  };

  if (!rl.allowed) {
    const retrySecs = Math.ceil((rl.resetMs - now) / 1000);
    return Response.json(
      {
        ok: false,
        error: {
          code: "rate_limited",
          message: "Too Many Requests",
          retry_after_ms: rl.resetMs - now,
        },
      } satisfies ApiError,
      {
        status: 429,
        headers: buildHeaders(
          { ...rlHeaders, "Retry-After": String(retrySecs) },
          req.headers.get("origin"),
        ),
      },
    );
  }

  return { allowed: true, headers: rlHeaders };
}

Bun.serve({
  port: PORTS.bun,
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,

  routes: {
    "/health": {
      GET: (req: Request, srv: unknown) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/health",
          query: {},
          cookies: {},
        };
        return Response.json(body, {
          headers: buildHeaders(rl.headers, req.headers.get("origin")),
        });
      },
    },

    "/api/users": {
      GET: (req: Request, srv: unknown) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const url = new URL(req.url);
        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/users",
          query: parseQuery(url),
          cookies: cookiesToRecord((req as unknown as { cookies?: unknown }).cookies),
        };
        return Response.json(body, {
          headers: buildHeaders(rl.headers, req.headers.get("origin")),
        });
      },

      POST: async (req: Request, srv: unknown) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const url = new URL(req.url);
        const origin = req.headers.get("origin");

        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "unsupported_media_type",
                message: "Content-Type must be application/json",
              },
            } satisfies ApiError,
            { status: 415, headers: buildHeaders({}, origin) },
          );
        }

        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          return Response.json(
            {
              ok: false,
              error: { code: "invalid_json", message: "Invalid JSON body" },
            } satisfies ApiError,
            { status: 400, headers: buildHeaders({}, origin) },
          );
        }

        const validationError = validateUserBody(parsed);
        if (validationError) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "schema_validation_failed",
                message: validationError,
              },
            } satisfies ApiError,
            { status: 422, headers: buildHeaders({}, origin) },
          );
        }

        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/users",
          query: parseQuery(url),
          cookies: cookiesToRecord((req as unknown as { cookies?: unknown }).cookies),
          body: parsed,
        };
        return Response.json(body, {
          headers: buildHeaders(rl.headers, origin),
        });
      },

      PUT: async (req: Request, srv: unknown) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;
        const url = new URL(req.url);
        const origin = req.headers.get("origin");
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "unsupported_media_type",
                message: "Content-Type must be application/json",
              },
            },
            { status: 415, headers: buildHeaders({}, origin) },
          );
        }
        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          return Response.json(
            {
              ok: false,
              error: { code: "invalid_json", message: "Invalid JSON body" },
            },
            { status: 400, headers: buildHeaders({}, origin) },
          );
        }
        const validationError = validateUserBody(parsed);
        if (validationError) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "schema_validation_failed",
                message: validationError,
              },
            },
            { status: 422, headers: buildHeaders({}, origin) },
          );
        }
        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/users",
          query: parseQuery(url),
          cookies: cookiesToRecord((req as unknown as { cookies?: unknown }).cookies),
          body: parsed,
        };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },

      PATCH: async (req: Request, srv: unknown) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;
        const url = new URL(req.url);
        const origin = req.headers.get("origin");
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "unsupported_media_type",
                message: "Content-Type must be application/json",
              },
            },
            { status: 415, headers: buildHeaders({}, origin) },
          );
        }
        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          return Response.json(
            {
              ok: false,
              error: { code: "invalid_json", message: "Invalid JSON body" },
            },
            { status: 400, headers: buildHeaders({}, origin) },
          );
        }
        const validationError = validateUserBody(parsed);
        if (validationError) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "schema_validation_failed",
                message: validationError,
              },
            },
            { status: 422, headers: buildHeaders({}, origin) },
          );
        }
        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/users",
          query: parseQuery(url),
          cookies: cookiesToRecord((req as unknown as { cookies?: unknown }).cookies),
          body: parsed,
        };
        return Response.json(body, { headers: buildHeaders(rl.headers, origin) });
      },

      OPTIONS: (req: Request) => {
        const origin = req.headers.get("origin");
        const cors = corsHeaders(origin, true);
        if (!cors) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "cors_not_allowed",
                message: "CORS preflight not allowed",
              },
            },
            { status: 403, headers: SECURITY_HEADERS },
          );
        }
        return new Response(null, {
          status: 204,
          headers: { ...SECURITY_HEADERS, ...cors },
        });
      },
    },

    "/api/echo": {
      POST: (req: Request, srv: unknown) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const origin = req.headers.get("origin");
        const requestedContentType = req.headers.get("content-type") ?? "application/octet-stream";

        // Stream req.body directly — zero buffering for echo.
        return new Response(req.body, {
          status: 200,
          headers: buildHeaders({ ...rl.headers, "Content-Type": requestedContentType }, origin),
        });
      },
    },

    "/api/cookies": {
      GET: (req: Request, srv: unknown) => {
        const rl = checkRateLimit(req, srv);
        if (rl instanceof Response) return rl;

        const body: ApiOk = {
          ok: true,
          requestId: rl.headers["X-Request-Id"] ?? "",
          path: "/api/cookies",
          query: {},
          cookies: cookiesToRecord((req as unknown as { cookies?: unknown }).cookies),
        };
        return Response.json(body, {
          headers: buildHeaders(rl.headers, req.headers.get("origin")),
        });
      },
    },
  },

  fetch(req: Request) {
    const url = new URL(req.url);
    return Response.json(
      {
        ok: false,
        error: {
          code: "not_found",
          message: `Route ${req.method} ${url.pathname} not found`,
        },
      } satisfies ApiError,
      {
        status: 404,
        headers: buildHeaders({}, req.headers.get("origin")),
      },
    );
  },
});

console.log(`[bun] listening on :${PORTS.bun} (Bun.serve routes)`);
