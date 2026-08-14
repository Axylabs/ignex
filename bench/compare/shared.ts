/**
 * bench/compare/shared.ts — shared contract for the Bun vs Elysia vs Ignus
 * comparison benchmark.
 *
 * Ported from the `bun-rust-runtime-bench` (castrum) project's
 * `bench/servers/shared.ts` so the exact same workload runs against all three
 * servers. Every participant implements the SAME route set over this module:
 *
 *   GET  /health      — ApiOk { ok, requestId, path, query, cookies } + security
 *                       headers + CORS + (disabled) rate-limit check
 *   GET  /api/users   — parse query + cookies, echo back in ApiOk
 *   POST/PUT/PATCH /api/users
 *                     — content-type guard (415) → JSON parse (400) → schema
 *                       validation (422) → echo { query, cookies, body }
 *   POST /api/echo    — stream the raw body back verbatim (no buffering)
 *   GET  /api/cookies — parse cookies, echo back in ApiOk
 *   OPTIONS /api/users — CORS preflight (204)
 *   anything else     — 404 ApiError
 *
 * The load generator validates every 2xx response's shape:
 *   `ok === true` and `requestId` is a string (see `bench/compare/load.ts`).
 */
export const PORTS = {
  bun: 9120,
  elysia: 9121,
  ignus: 9122,
  /** AOT-compiled ignus participant (opt-in via `SERVER=ignus-aot`). */
  "ignus-aot": 9123,
} as const;

export type ServerKind = keyof typeof PORTS;

export const USER_SCHEMA = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "number" },
    name: { type: "string", minLength: 1, maxLength: 256 },
    email: { type: "string", format: "email" },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" }, maxItems: 20 },
  },
  additionalProperties: false,
} as const;

export const USER_SCHEMA_BYTES = new TextEncoder().encode(JSON.stringify(USER_SCHEMA));

/** Success envelope — the wire contract the load generator validates. */
export interface ApiOk {
  ok: true;
  requestId: string;
  path: string;
  query: Record<string, string | string[]>;
  cookies: Record<string, string>;
  body?: unknown;
}

/** Error envelope used for 4xx/5xx responses. */
export interface ApiError {
  ok: false;
  error: { code: string; message: string; retry_after_ms?: number };
}

export const CORS_CONFIG = {
  allowOrigin: ["https://app.example.com", "https://admin.example.com"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  exposeHeaders: ["X-Request-Id", "X-Trace-Id"],
  allowCredentials: true,
  maxAge: 86400,
} as const;

/**
 * Rate limiter config. `limit = UINT32_MAX` means the limiter is wired into
 * the pipeline but NEVER throttles — identical per-request work on all three
 * servers without distorting throughput (same trick as the rust project).
 */
export const RATE_LIMIT_CONFIG = {
  limit: 4_294_967_295,
  windowMs: 60_000,
} as const;

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-XSS-Protection": "0",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
};

/** Manual JSON-schema check shared by the raw Bun + Ignus servers. */
export function validateUserBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Body must be a JSON object";
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) {
    return "Field 'id' must be a finite number";
  }
  if (typeof obj.name !== "string" || obj.name.length === 0 || obj.name.length > 256) {
    return "Field 'name' must be a string between 1 and 256 characters";
  }
  if (obj.email !== undefined && typeof obj.email !== "string") {
    return "Field 'email' must be a string";
  }
  if (obj.active !== undefined && typeof obj.active !== "boolean") {
    return "Field 'active' must be a boolean";
  }
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.length > 20) {
      return "Field 'tags' must be an array with at most 20 items";
    }
    for (const tag of obj.tags) {
      if (typeof tag !== "string") return "All tags must be strings";
    }
  }
  const allowed = new Set(["id", "name", "email", "active", "tags"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `Unknown field '${key}'`;
  }
  return null;
}

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ── Shared per-request helpers ─────────────────────────────────────────
// Factored here (instead of duplicated per server, as in the rust project)
// so every participant runs byte-identical logic for the "same work" claim.

const rateBuckets = new Map<string, { prev: number; curr: number; windowStart: number }>();

/** In-memory sliding-window rate limiter (limit is disabled in the bench). */
export function rateLimitCheck(
  ip: string,
  now: number,
): { allowed: boolean; remaining: number; resetMs: number } {
  const limit = RATE_LIMIT_CONFIG.limit;
  const window = RATE_LIMIT_CONFIG.windowMs;
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { prev: 0, curr: 0, windowStart: now };
    rateBuckets.set(ip, bucket);
  }
  let elapsed = now - bucket.windowStart;
  if (elapsed >= window * 2) {
    bucket.prev = 0;
    bucket.curr = 0;
    bucket.windowStart = now;
    elapsed = 0;
  } else if (elapsed >= window) {
    bucket.prev = bucket.curr;
    bucket.curr = 0;
    bucket.windowStart += window;
    elapsed -= window;
  }
  const overlap = window - elapsed;
  const weighted = (bucket.prev * overlap) / window + bucket.curr;
  const reset = bucket.windowStart + window;
  if (weighted < limit) {
    bucket.curr++;
    return {
      allowed: true,
      remaining: Math.max(0, limit - Math.floor(weighted) - 1),
      resetMs: reset,
    };
  }
  return { allowed: false, remaining: 0, resetMs: reset };
}

export function corsHeaders(
  origin: string | null,
  isPreflight: boolean,
): Record<string, string> | null {
  if (
    !origin ||
    !CORS_CONFIG.allowOrigin.includes(origin as (typeof CORS_CONFIG.allowOrigin)[number])
  ) {
    return null;
  }
  const h: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    Vary: isPreflight
      ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
      : "Origin",
  };
  if (CORS_CONFIG.allowCredentials) h["Access-Control-Allow-Credentials"] = "true";
  if (isPreflight) {
    h["Access-Control-Allow-Methods"] = CORS_CONFIG.allowMethods.join(", ");
    h["Access-Control-Allow-Headers"] = CORS_CONFIG.allowHeaders.join(", ");
    h["Access-Control-Max-Age"] = String(CORS_CONFIG.maxAge);
  } else if (CORS_CONFIG.exposeHeaders.length > 0) {
    h["Access-Control-Expose-Headers"] = CORS_CONFIG.exposeHeaders.join(", ");
  }
  return h;
}

export function buildHeaders(
  extra: Record<string, string>,
  origin: string | null,
  isPreflight = false,
): Record<string, string> {
  const cors = corsHeaders(origin, isPreflight);
  return {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json",
    ...extra,
    ...cors,
  };
}

export function getClientIp(req: Request, server: unknown): string {
  const srv = server as { requestIP?(req: Request): { address: string } | null } | null;
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    srv?.requestIP?.(req)?.address ??
    "127.0.0.1"
  );
}

export function parseQuery(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Convert Bun's CookieMap (or any entries-iterable) to a plain object. */
export function cookiesToRecord(cookies: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (cookies && typeof (cookies as { entries?: unknown }).entries === "function") {
    for (const [key, value] of (
      cookies as {
        entries(): Iterable<[string, string]>;
      }
    ).entries()) {
      out[key] = value;
    }
  }
  return out;
}
