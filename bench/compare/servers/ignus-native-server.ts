/**
 * bench/compare/servers/ignus-native-server.ts — Ignex comparison participant
 * WITH the Rust native pre-flight pipeline.
 *
 * Byte-identical route contract + server to `ignus-server.ts` (the pure-JS
 * ignex baseline), with ONE difference: the `nativePreflight` plugin is added
 * to the stack. It runs castrum's Rust ingress pre-flight (`createPipeline`) on
 * every request — URL/header/query limits + body-size guard in ONE native call,
 * with the app's security headers pre-baked into castrum's terminal/error
 * responses (413/400/422/429/etc. carry the same posture WITHOUT a JS lifecycle
 * round-trip). The JS `cors()`/`security()` plugins still handle CORS + the OK
 * path's headers (nativePreflight is wired with no `cors`/`rateLimit` options,
 * so there is NO double-apply).
 *
 * Comparing `ignus` vs `ignus-native` in `bench/compare/run-bench.ts` measures
 * the REAL native delta (pre-flight + terminal short-circuit) against the
 * pure-JS ignex baseline — the number Phase B's `createIngressRouter`
 * delegation must beat.
 */
import { cors, createApp, createRouter, nativePreflight, security } from "@ignex/core";
import {
  type ApiError,
  type ApiOk,
  CORS_CONFIG,
  MAX_BODY_BYTES,
  PORTS,
  parseQuery,
  RATE_LIMIT_CONFIG,
  rateLimitCheck,
  SECURITY_HEADERS,
  validateUserBody,
} from "../shared";

const okBody = (
  ctx: { requestId: string },
  path: string,
  query: Record<string, string | string[]>,
  cookies: Record<string, string>,
  body?: unknown,
): ApiOk => ({
  ok: true,
  requestId: ctx.requestId,
  path,
  query,
  cookies,
  ...(body === undefined ? {} : { body }),
});

const errorBody = (error: {
  code: string;
  message: string;
  retry_after_ms?: number;
}): ApiError => ({
  ok: false,
  error,
});

const queryRecord = (ctx: { url: URL }): Record<string, string | string[]> => parseQuery(ctx.url);

const cookiesRecord = (ctx: {
  cookie: Record<string, { value?: string }>;
}): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, cookie] of Object.entries(ctx.cookie)) {
    out[key] = cookie.value ?? "";
  }
  return out;
};

/** POST/PUT/PATCH /api/users — content-type guard → JSON parse → validation → echo. */
const usersBody = async (ctx: Parameters<Parameters<typeof createApp>[0]["handler"]>[0]) => {
  const contentType = ctx.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return ctx.json(
      errorBody({
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      }),
      { status: 415 },
    );
  }

  let parsed: unknown;
  try {
    parsed = await ctx.body.json();
  } catch {
    return ctx.json(errorBody({ code: "invalid_json", message: "Invalid JSON body" }), {
      status: 400,
    });
  }

  const validationError = validateUserBody(parsed);
  if (validationError) {
    return ctx.json(errorBody({ code: "schema_validation_failed", message: validationError }), {
      status: 422,
    });
  }

  return ctx.json(okBody(ctx, "/api/users", queryRecord(ctx), cookiesRecord(ctx), parsed));
};

// ── Per-request guard: request-id + rate-limit headers (disabled limit) ──
// Same work as the raw Bun/Elysia servers. Runs before every handler as a
// beforeHandle hook; the 429 path halts the chain with a Response (headers
// accumulate into `ctx.set` and are applied exactly once by the router).
const guard = (
  ctx: Parameters<Parameters<typeof createApp>[0]["handler"]>[0],
): Response | undefined => {
  const now = Date.now();
  const rl = rateLimitCheck(ctx.ip, now);
  ctx.set.headers["X-Request-Id"] = ctx.requestId;
  ctx.set.headers["RateLimit-Limit"] = String(RATE_LIMIT_CONFIG.limit);
  ctx.set.headers["RateLimit-Remaining"] = String(rl.remaining);
  ctx.set.headers["RateLimit-Reset"] = String(Math.ceil(rl.resetMs / 1000));
  if (!rl.allowed) {
    ctx.set.headers["Retry-After"] = String(Math.ceil((rl.resetMs - now) / 1000));
    return ctx.json(
      errorBody({
        code: "rate_limited",
        message: "Too Many Requests",
        retry_after_ms: rl.resetMs - now,
      }),
      { status: 429 },
    );
  }
  return undefined;
};

const app = createApp({
  plugins: [
    cors({
      origin: [...CORS_CONFIG.allowOrigin],
      methods: [...CORS_CONFIG.allowMethods],
      allowedHeaders: [...CORS_CONFIG.allowHeaders],
      exposedHeaders: [...CORS_CONFIG.exposeHeaders],
      credentials: CORS_CONFIG.allowCredentials,
      maxAge: CORS_CONFIG.maxAge,
    }),
    security({
      contentSecurityPolicy: SECURITY_HEADERS["Content-Security-Policy"],
    }),
    // Rust native pre-flight: one castrum ingress call per request enforces the
    // default limits/body-guard and pre-bakes the security headers into
    // terminal/error responses. No `cors`/`rateLimit` options → those stay with
    // the JS plugins (no double-apply). Safe no-op when the addon is absent.
    nativePreflight({
      runtime: {
        securityHeaders: [
          ["x-frame-options", "SAMEORIGIN"],
          ["x-content-type-options", "nosniff"],
          ["referrer-policy", "no-referrer"],
        ],
      },
    }),
  ],

  lifecycle: { beforeHandle: [guard] },

  router: createRouter()
    // HEAD behaves like GET (Bun auto-answers HEAD for GET routes; the
    // runtime strips the response body), matching Bun/Elysia.
    .get("/health", (ctx) => ctx.json(okBody(ctx, "/health", {}, {})))
    .get("/api/users", (ctx) =>
      ctx.json(okBody(ctx, "/api/users", queryRecord(ctx), cookiesRecord(ctx))),
    )
    .post("/api/users", usersBody)
    .put("/api/users", usersBody)
    .patch("/api/users", usersBody)
    .post("/api/echo", async (ctx) => {
      const requestedContentType = ctx.headers.get("content-type") ?? "application/octet-stream";
      // Raw `Response` is a passthrough in the ignex pipeline, so the request
      // body streams back with zero buffering (security/CORS plugins still
      // decorate it in the post stages).
      return new Response(ctx.req.body, {
        status: 200,
        headers: { "content-type": requestedContentType },
      });
    })
    .get("/api/cookies", (ctx) => ctx.json(okBody(ctx, "/api/cookies", {}, cookiesRecord(ctx)))),
});

await app.init();
app.serve({
  port: PORTS["ignus-native"],
  hostname: "0.0.0.0",
  // Plain HTTP like every other compare participant (the load generator speaks
  // http://). Core's TLS default is HTTPS-with-dev-certs since the tls.ts work;
  // ignus-server.ts pins `false` too.
  https: false,
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,
});
console.log(
  `[ignus-native] listening on :${PORTS["ignus-native"]} (createApp+router+nativePreflight, native=${
    process.env.IGNEX_NATIVE ?? "on"
  })`,
);
