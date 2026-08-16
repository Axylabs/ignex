/**
 * @fileoverview Direct C-ABI ingress pipeline (`createNativeIngress`).
 *
 * Drives castrum's full native ingress pipeline (CORS / rate-limit / IP-trust /
 * body-guard / JSON-schema) through the `castrum_ingress_*` C-ABI surface —
 * NO castrum TS-layer round trip. Transfer is minimal-overhead by construction:
 *   - `url`/`ip` cross as `cstring` ARGs — the engine transcodes the JS strings
 *     in-engine (ZERO JS-side `encoder.encode`, no frame assembly for URL/IP);
 *   - the packed headers block (or the empty block when the route needs none)
 *     is written into a pooled scratch buffer;
 *   - the 48-byte output header is decoded with cached DataView reads (no
 *     TextDecoder, no intermediate objects);
 *   - the opaque `inner` handle comes from the napi `Ingress` instance, which is
 *     held alive for the handle's lifetime (same contract as the route/instance
 *     surfaces).
 *
 * The output normalizes into the SAME {@link NativePreflightOutcome} shape as
 * `createNativePipeline` (pipeline.ts), so `nativePreflight` can prefer this
 * path with zero plugin changes. Returns `null`-friendly factories (never
 * throw) when the addon lacks the ingress symbols.
 */

import { getFfiIngress } from "./ffi";
import { getNative } from "./loader";
import type {
  NativeIngressOptions,
  NativePreflightOutcome,
  NativePreflightResult,
} from "./pipeline";
import { withScratch } from "./scratch";
import { encoder } from "./util";

// ── Output wire offsets (rust/ingress/output.rs — the canonical source) ──
const OUT_VERDICT = 0; // u8
const OUT_ERROR_CODE = 1; // u8
const OUT_STATUS = 2; // u16 LE
const OUT_FLAGS = 4; // u32
const OUT_RATE_LIMIT = 8; // u32
const OUT_RATE_REMAINING = 12; // u32
const OUT_RATE_RESET = 16; // u64 ms
const OUT_RETRY_AFTER = 24; // u64 ms
const OUT_COOKIES_JSON_LEN = 32; // u32
const OUT_QUERY_JSON_LEN = 36; // u32
const OUT_HEADER_VARIANT = 40; // u8
const OUT_BODY_JSON_LEN = 44; // u32
const OUT_DATA_START = 48;

// Header-variant bits (output.rs).
const HV_CORS_SIMPLE = 2;
const HV_CORS_PREFLIGHT = 4;
const HV_RATE_ACTIVE = 8;
const HV_RATE_LIMITED = 16;

// Native error codes (output.rs).
const ERR_CORS_PREFLIGHT = 1;
const ERR_RATE_LIMITED = 2;
const ERR_BODY_TOO_LARGE = 3;
const ERR_INVALID_JSON = 4;
const ERR_SCHEMA_VALIDATION = 5;
const ERR_BAD_REQUEST = 6;
const ERR_REQUEST_TOO_LARGE = 7;
const ERR_INTERNAL = 8;

/** HTTP method → native ingress method-kind enum (shared.ts). */
const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};
const METHOD_KIND_UNKNOWN = 7;

/** Default ingress output-buffer size (bytes) — pooled per instance. */
const DEFAULT_OUTPUT_BUFFER_SIZE = 131_072;
/** Absolute cap on the ingress output buffer (matches castrum). */
const MAX_OUTPUT_BUFFER_SIZE = 64 * 1024 * 1024;

// ── Pre-encoded error bodies (benchmark wire, castrum-parity) ──
const staticErrorBody = (code: string, message: string): Uint8Array =>
  encoder.encode(`{"ok":false,"error":{"code":"${code}","message":"${message}"}}`);

const ERROR_BODIES: Record<number, Uint8Array> = {
  [ERR_CORS_PREFLIGHT]: staticErrorBody("cors_preflight_not_allowed", "CORS preflight not allowed"),
  [ERR_RATE_LIMITED]: staticErrorBody("rate_limited", "Too Many Requests"),
  [ERR_BODY_TOO_LARGE]: staticErrorBody("body_too_large", "Request body is too large"),
  [ERR_INVALID_JSON]: staticErrorBody("invalid_json", "Invalid JSON body"),
  [ERR_SCHEMA_VALIDATION]: staticErrorBody(
    "schema_validation_failed",
    "Request body failed schema validation",
  ),
  [ERR_BAD_REQUEST]: staticErrorBody("bad_request", "Bad request"),
  [ERR_REQUEST_TOO_LARGE]: staticErrorBody("request_too_large", "Request too large"),
  [ERR_INTERNAL]: staticErrorBody("internal_error", "Internal server error"),
};

const RATE_LIMIT_BODY_PREFIX = encoder.encode(
  '{"ok":false,"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":',
);
const RATE_LIMIT_BODY_SUFFIX = encoder.encode("}}");

/** Rate-limited error body with `retry_after_ms` inlined. */
function rateLimitedBody(retryAfterMs: number): Uint8Array {
  const digits = encoder.encode(String(Math.max(0, Math.floor(retryAfterMs))));
  const out = new Uint8Array(
    RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength + RATE_LIMIT_BODY_SUFFIX.byteLength,
  );
  out.set(RATE_LIMIT_BODY_PREFIX, 0);
  out.set(digits, RATE_LIMIT_BODY_PREFIX.byteLength);
  out.set(RATE_LIMIT_BODY_SUFFIX, RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength);
  return out;
}

/** Fallback status per native error code (when the native status is 0). */
const ERROR_STATUS: Record<number, number> = {
  [ERR_CORS_PREFLIGHT]: 403,
  [ERR_RATE_LIMITED]: 429,
  [ERR_BODY_TOO_LARGE]: 413,
  [ERR_INVALID_JSON]: 400,
  [ERR_SCHEMA_VALIDATION]: 422,
  [ERR_BAD_REQUEST]: 400,
  [ERR_REQUEST_TOO_LARGE]: 413,
  [ERR_INTERNAL]: 500,
};

/** Which request headers to extract into the packed block (shared.ts parity). */
export interface IngressHeaderPlan {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}

/** Build the header plan from ingress options (mirrors castrum's buildHeaderPlan). */
export function buildIngressHeaderPlan(options: {
  parseCookies?: boolean;
  cors?: unknown;
  trustProxy?: boolean;
  trustedProxies?: { enabled?: boolean };
  https?: boolean;
}): IngressHeaderPlan {
  const trust = options.trustProxy === true || options.trustedProxies?.enabled === true;
  return {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust,
    proto: trust && options.https === undefined,
  };
}

/** Shared `[u16 count 0]` empty headers block (never mutated — safe to reuse). */
const EMPTY_HEADERS = new Uint8Array([0, 0]);

/**
 * Pack the headers selected by `plan` into the native `[u16 count]{[u16 klen]
 * [key][u32 vlen][value]}` block, written into a pooled scratch buffer (no
 * per-request alloc; valid only for the duration of the FFI call). A route
 * needing no headers yields the 2-byte empty block (count 0). The scratch is
 * sized to the EXACT UTF-8 bound (≤3× per UTF-16 code unit) so no selected
 * header is ever dropped.
 */
function packSelectedHeaders(
  req: Request,
  plan: IngressHeaderPlan,
  methodKind: number,
): Uint8Array {
  const entries: Array<[string, string]> = [];
  if (plan.cookie) {
    const v = req.headers.get("cookie");
    if (v != null) entries.push(["cookie", v]);
  }
  if (plan.cors) {
    const v = req.headers.get("origin");
    if (v != null) entries.push(["origin", v]);
    if (methodKind === METHOD_KIND.OPTIONS) {
      const acrm = req.headers.get("access-control-request-method");
      if (acrm != null) entries.push(["access-control-request-method", acrm]);
      const acrh = req.headers.get("access-control-request-headers");
      if (acrh != null) entries.push(["access-control-request-headers", acrh]);
    }
  }
  if (plan.proxy) {
    for (const name of ["x-forwarded-for", "x-real-ip"]) {
      const v = req.headers.get(name);
      if (v != null) entries.push([name, v]);
    }
  }
  if (plan.proto) {
    const v = req.headers.get("x-forwarded-proto");
    if (v != null) entries.push(["x-forwarded-proto", v]);
  }

  let bound = 2; // [u16 count]
  for (const [name, value] of entries) bound += 2 + name.length + 4 + value.length * 3;
  if (entries.length === 0) return EMPTY_HEADERS;
  return withScratch(bound, (scratch) => {
    const view = new DataView(scratch.buffer, scratch.byteOffset, scratch.byteLength);
    let pos = 2;
    for (const [name, value] of entries) {
      view.setUint16(pos, name.length, true);
      scratch.set(encoder.encode(name), pos + 2);
      pos += 2 + name.length;
      const lenPos = pos;
      pos += 4;
      const written = encoder.encodeInto(value, scratch.subarray(pos, scratch.length)).written;
      view.setUint32(lenPos, written, true);
      pos += written;
    }
    view.setUint16(0, entries.length, true);
    return scratch.subarray(0, pos);
  });
}

/** Decoded 48-byte ingress output header (primitives only — no escaping buffers). */
interface IngressVerdict {
  ok: boolean;
  errorCode: number;
  status: number;
  flags: number;
  rateLimit: number;
  rateRemaining: number;
  rateResetMs: number;
  retryAfterMs: number;
  headerVariant: number;
  cookiesJsonLen: number;
  queryJsonLen: number;
  bodyJsonLen: number;
}

/**
 * Decode the output header from `buf[0..48]` into `target` with cached
 * DataView reads. Writes into a caller-provided (pooled) target so the hot
 * path allocates ZERO objects per request — the decode result is consumed
 * synchronously before the next request reuses the same target.
 */
function decodeVerdict(buf: Uint8Array, view: DataView, target: IngressVerdict): IngressVerdict {
  target.ok = buf[OUT_VERDICT] === 0;
  target.errorCode = buf[OUT_ERROR_CODE] ?? 0;
  target.status = view.getUint16(OUT_STATUS, true);
  target.flags = view.getUint32(OUT_FLAGS, true);
  target.rateLimit = view.getUint32(OUT_RATE_LIMIT, true);
  target.rateRemaining = view.getUint32(OUT_RATE_REMAINING, true);
  target.rateResetMs = Number(view.getBigUint64(OUT_RATE_RESET, true));
  target.retryAfterMs = Number(view.getBigUint64(OUT_RETRY_AFTER, true));
  target.headerVariant = buf[OUT_HEADER_VARIANT] ?? 0;
  target.cookiesJsonLen = view.getUint32(OUT_COOKIES_JSON_LEN, true);
  target.queryJsonLen = view.getUint32(OUT_QUERY_JSON_LEN, true);
  target.bodyJsonLen = view.getUint32(OUT_BODY_JSON_LEN, true);
  return target;
}

/** Whole-seconds ceil (rate-limit headers are whole seconds). */
const secondsFromMs = (ms: number): number => Math.ceil(ms / 1000);

/**
 * Decode a captured path segment, keeping the raw (undecoded) text when the
 * percent-encoding is malformed — a client URIError must not become a 500.
 */
const safeDecodeParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Runtime hooks: pre-baked security headers applied to terminal responses. */
export interface NativeIngressRuntime {
  /** Ordered `[name, value][]` security headers baked into terminal responses. */
  securityHeaders?: ReadonlyArray<[string, string]>;
  /** Output buffer size (bytes). Default 131072. */
  outputBufferSize?: number;
}

/** A direct C-ABI ingress pre-flight instance. */
export interface NativeIngress {
  /**
   * Run the pipeline once for a request. Returns the outcome SYNCHRONOUSLY
   * (the C-ABI core is sync) — no per-request Promise/microtask — typed as
   * `Promise | value` so callers can `await` if they prefer. On any native
   * failure resolves to a non-terminal outcome (never breaks the flow).
   */
  preprocess(
    request: Request,
    ip?: string,
  ): NativePreflightOutcome | Promise<NativePreflightOutcome>;
  /**
   * True when the config needs the client IP (rate-limit / trust-proxy).
   * Callers should pass `undefined` when false to skip the `requestIP` lookup.
   */
  readonly needsIp: boolean;
  /** Release the underlying napi instance + handle. */
  destroy(): void;
}

const U32_MAX = 4_294_967_295; // castrum's "rate limiting disabled" sentinel

/**
 * Create a direct C-ABI ingress pre-flight instance (or `null` when the addon
 * lacks the ingress symbols). Each request runs ONE `castrum_ingress_handle_*`
 * call with `cstring` url/ip + the packed headers block, and the 48-byte
 * verdict is decoded with zero TextDecoder/alloc. Terminal decisions build a
 * response with the pre-baked security headers + rate-limit/CORS headers.
 */
export const createNativeIngress = (
  options: NativeIngressOptions = {},
  runtime: NativeIngressRuntime = {},
): NativeIngress | null => {
  const ffiIng = getFfiIngress();
  if (!ffiIng) return null;
  const addon = getNative();
  if (!addon || typeof (addon as { Ingress?: unknown }).Ingress !== "function") return null;

  let instance: { ingressInnerPtr(): bigint };
  try {
    // Cast ONLY the constructor accessor — `new addon(...)` would construct the
    // module (not a constructor); `new IngressCtor(...)` constructs the napi class.
    const IngressCtor = (
      addon as unknown as { Ingress: new (o: unknown) => { ingressInnerPtr(): bigint } }
    ).Ingress;
    instance = new IngressCtor(options);
  } catch {
    return null;
  }
  const inner = Number(instance.ingressInnerPtr());
  if (!inner) return null;

  const plan = buildIngressHeaderPlan(options);
  const trustEnabled = options.trustProxy === true || options.trustedProxies?.enabled === true;
  const rateEnabled = options.rateLimit != null;
  const securityEntries: ReadonlyArray<[string, string]> = Object.freeze([
    ...(runtime.securityHeaders ?? []),
  ]);
  const outputBufferSize = Math.min(
    MAX_OUTPUT_BUFFER_SIZE,
    Math.max(OUT_DATA_START, Math.floor(runtime.outputBufferSize ?? DEFAULT_OUTPUT_BUFFER_SIZE)),
  );
  // Per-instance reusable output buffer + cached DataView (no per-request alloc;
  // decoded synchronously before the next request reuses it — same discipline
  // as castrum's BufferPool happy path).
  let output = new Uint8Array(outputBufferSize);
  let outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);

  const corsOpts = options.cors;

  const growOutput = (needed: number): void => {
    if (needed <= output.length) return;
    let cap = output.length * 2;
    while (cap < needed) cap *= 2;
    output = new Uint8Array(Math.min(cap, MAX_OUTPUT_BUFFER_SIZE));
    outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);
  };

  // Pooled per-request objects — consumed synchronously by the caller before
  // the next request reuses them (same discipline as the pooled output buffer
  // and the `withScratch` arena). Eliminates 2 allocations per request off the
  // hot path. The OK `body` is a shared immutable empty view (never mutated).
  const verdict: IngressVerdict = {
    ok: false,
    errorCode: 0,
    status: 0,
    flags: 0,
    rateLimit: 0,
    rateRemaining: 0,
    rateResetMs: 0,
    retryAfterMs: 0,
    headerVariant: 0,
    cookiesJsonLen: 0,
    queryJsonLen: 0,
    bodyJsonLen: 0,
  };
  const okResult: NativePreflightResult = {
    ok: true,
    status: 200,
    terminal: false,
    rateLimited: false,
    requestId: "",
    body: EMPTY_BYTES,
  };

  const runOnce = (request: Request, ip: string | undefined): NativePreflightOutcome => {
    const methodKind = METHOD_KIND[request.method] ?? METHOD_KIND_UNKNOWN;
    const headers = packSelectedHeaders(request, plan, methodKind);
    // ip: the plugin passes `ctx.ip`; default to the empty string (cstring "").
    const ipStr = ip ?? "";
    growOutput(OUT_DATA_START);
    const w = ffiIng.ingressHandleComponents(
      inner,
      methodKind,
      request.url,
      ipStr,
      EMPTY_RID,
      headers,
      null,
      output,
    );
    if (w === 0) {
      // Native failure → non-terminal (the request flow is never broken).
      return { terminal: false, response: null, result: null };
    }
    if (w > output.length) {
      growOutput(w);
      const w2 = ffiIng.ingressHandleComponents(
        inner,
        methodKind,
        request.url,
        ipStr,
        EMPTY_RID,
        headers,
        null,
        output,
      );
      if (w2 === 0 || w2 > output.length) {
        return { terminal: false, response: null, result: null };
      }
    }
    const v = decodeVerdict(output, outputView, verdict);
    if (v.ok) {
      // Reuse the pooled OK result (consumed synchronously; no per-request
      // object allocation). `ok`/`terminal`/`requestId`/`body` never change;
      // the two mutable fields are written through a pooled mutable slot (the
      // readonly surface is for external callers — callers must not retain the
      // result past the synchronous consumption).
      const slot = okResult as { status: number; rateLimited: boolean };
      slot.status = v.status || 200;
      slot.rateLimited = (v.flags & (1 << 6)) !== 0;
      return { terminal: false, response: null, result: okResult };
    }
    // Terminal: build the response (status + baked headers + error body).
    return {
      terminal: true,
      response: buildTerminalResponse(request, v, securityEntries, corsOpts),
      result: null,
    };
  };

  return {
    preprocess(request, ip) {
      // Synchronous: the C-ABI core does not await anything, so returning the
      // value directly (not via an `async` fn) avoids a per-request Promise
      // allocation + microtask on every request.
      return runOnce(request, ip);
    },
    needsIp: rateEnabled || trustEnabled,
    destroy() {
      // The napi instance is GC'd when the closure drops; nothing else to free.
      instance = undefined as unknown as { ingressInnerPtr(): bigint };
    },
  };
};

const EMPTY_RID = new Uint8Array(0);
/** Shared immutable empty body view for pooled OK results (never mutated). */
const EMPTY_BYTES = new Uint8Array(0);

/** Build the terminal response from a decoded verdict (status + headers + body). */
function buildTerminalResponse(
  request: Request,
  v: IngressVerdict,
  securityEntries: ReadonlyArray<[string, string]>,
  cors: NativeIngressOptions["cors"],
): Response {
  const hv = v.headerVariant;
  const headers: Array<[string, string]> = [
    ...securityEntries,
    ...buildRateLimitHeaders(v, hv),
    ...buildCorsHeaders(request, hv, cors),
  ];
  const status = v.status || ERROR_STATUS[v.errorCode] || 400;
  const body =
    v.errorCode === ERR_RATE_LIMITED
      ? rateLimitedBody(v.retryAfterMs || 0)
      : (ERROR_BODIES[v.errorCode] ?? ERROR_BODIES[ERR_INTERNAL]);
  return new Response(body as unknown as BodyInit, { status, headers });
}

/** Rate-limit response headers (limit/remaining/reset + retry-after when limited). */
function buildRateLimitHeaders(v: IngressVerdict, hv: number): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const rateActive = (hv & HV_RATE_ACTIVE) !== 0;
  const rateLimited = (hv & HV_RATE_LIMITED) !== 0 || v.errorCode === ERR_RATE_LIMITED;
  if (rateActive) {
    if (v.rateLimit !== U32_MAX) headers.push(["ratelimit-limit", String(v.rateLimit)]);
    headers.push(["ratelimit-remaining", String(v.rateRemaining)]);
    headers.push(["ratelimit-reset", String(secondsFromMs(v.rateResetMs))]);
  }
  if (rateLimited) {
    headers.push(["retry-after", String(secondsFromMs(v.retryAfterMs || 0))]);
  }
  return headers;
}

/** CORS response headers for simple + preflight outcomes (empty when CORS inactive). */
function buildCorsHeaders(
  request: Request,
  hv: number,
  cors: NativeIngressOptions["cors"],
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const corsSimple = (hv & HV_CORS_SIMPLE) !== 0;
  const corsPreflight = (hv & HV_CORS_PREFLIGHT) !== 0;
  if ((corsSimple || corsPreflight) && cors) {
    const origin = request.headers.get("origin");
    if (origin != null) {
      headers.push(["access-control-allow-origin", origin]);
      if (cors.allowCredentials) headers.push(["access-control-allow-credentials", "true"]);
    }
    if (corsPreflight) {
      if (corsAllowMethodsValue(cors))
        headers.push(["access-control-allow-methods", corsAllowMethodsValue(cors)]);
      if (corsAllowHeadersValue(cors))
        headers.push(["access-control-allow-headers", corsAllowHeadersValue(cors)]);
      if (corsMaxAgeValue(cors)) headers.push(["access-control-max-age", corsMaxAgeValue(cors)]);
    }
    if (corsExposeHeadersValue(cors))
      headers.push(["access-control-expose-headers", corsExposeHeadersValue(cors)]);
  }
  return headers;
}

const corsAllowMethodsValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.allowMethods?.join(", ") ?? "";
const corsAllowHeadersValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.allowHeaders?.join(", ") ?? "";
const corsExposeHeadersValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.exposeHeaders?.join(", ") ?? "";
const corsMaxAgeValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.maxAge != null ? String(c.maxAge) : "";

// ── Per-route native ingress router (`createNativeIngressRouter`) ──
// The "one super solution" over the global pipeline: each route in the table
// compiles a DEDICATED native pipeline pruned to EXACTLY that route's stages
// (castrum's `createIngressRouter` model). A route that needs no CORS/rate/
// cookies/query gathers ZERO headers and runs a near-empty pipeline — the
// per-route pruning win. All routes share the same C-ABI wire + a shared
// fallback responder for the non-terminal (app-owned) path.

/** Per-route spec for {@link createNativeIngressRouter}. */
export interface NativeIngressRouterRoute {
  /** Per-route ingress options — compiled into a DEDICATED native pipeline. */
  options?: NativeIngressOptions;
}

/** Options for {@link createNativeIngressRouter}. */
export interface CreateNativeIngressRouterOptions {
  /** Route table: path → per-route ingress options. */
  routes: Record<string, NativeIngressRouterRoute>;
  /** Shared runtime (security headers / output buffer) applied to every route. */
  runtime?: NativeIngressRuntime;
  /**
   * Responder for non-terminal (OK) requests — the app's own handler. The
   * router serves the pipeline's terminal decision (CORS/429/413/400/422)
   * and delegates the OK path to this. Default: a JSON `{"ok":true}` 200.
   */
  fallback?: (req: Request) => Response | Promise<Response>;
  /** Pre-warm every compiled route's pipeline at construction. Default: false. */
  warmOnCreate?: boolean;
}

/** A compiled per-route native ingress router. */
export interface NativeIngressRouter {
  /** Per-path compiled pre-flight instances (null when a path could not compile). */
  routeHandlers: Record<string, NativeIngress | null>;
  /** Bun.serve-compatible route table (each method → the pre-flight handler). */
  routes: Record<string, Record<string, (req: Request) => Response | Promise<Response>>>;
  /** Path matcher (`:param` / `*` dynamic routes), most-specific-first. */
  match(pathname: string): { path: string; params: Record<string, string> } | undefined;
  /** Pre-warm every compiled route (JIT the pipeline + FFI call). */
  prewarm(): Promise<void>;
}

const ROUTER_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Compile a `:param` / `*` route path into a RegExp + param names. */
function compileRoutePath(path: string): { re: RegExp; params: string[]; staticSegments: number } {
  const params: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg === "*") return "(?:/(.*))?";
      if (seg.startsWith(":")) {
        params.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^${src}\\/?$`), params, staticSegments: path.split("/").length };
}

/**
 * Compile a route table into per-route native ingress pipelines. Each route
 * with `options` compiles its OWN `createNativeIngress` — a dedicated
 * `IngressInner` pruned to that route's stages + per-route header plan (routes
 * needing nothing gather ZERO headers). `routes` is Bun.serve-compatible;
 * `match`/`prewarm` mirror castrum's `createIngressRouter`.
 */
export const createNativeIngressRouter = (
  options: CreateNativeIngressRouterOptions,
): NativeIngressRouter | null => {
  const runtime = options.runtime ?? {};
  const fallback =
    options.fallback ?? ((_req: Request): Response => new Response('{"ok":true}', { status: 200 }));

  const compiled: Record<string, NativeIngress | null> = {};
  const routeTable: Record<
    string,
    Record<string, (req: Request) => Response | Promise<Response>>
  > = {};

  for (const [path, spec] of Object.entries(options.routes)) {
    const ingress = createNativeIngress(spec.options ?? {}, runtime);
    compiled[path] = ingress;
    if (!ingress) continue;
    // Per-route pre-flight handler: serve the pipeline's terminal decision,
    // else delegate the OK path to the app's fallback responder.
    const handler = async (req: Request): Promise<Response> => {
      // Sync fast path: the C-ABI core returns the outcome directly, so branch
      // on Promise instead of awaiting unconditionally — avoids a per-request
      // await suspension + microtask (the async fn still yields to Bun.serve).
      const outcome = ingress.preprocess(req);
      const { terminal, response } = outcome instanceof Promise ? await outcome : outcome;
      return terminal && response ? response : fallback(req);
    };
    const methods: Record<string, (req: Request) => Response | Promise<Response>> = {};
    for (const m of ROUTER_METHODS) methods[m] = handler;
    routeTable[path] = methods;
  }

  // Most-specific-first matcher (static segments desc, then fewer params).
  const patterns = Object.entries(compiled)
    .filter(([, ing]) => ing !== null)
    .map(([path]) => ({ path, ...compileRoutePath(path) }))
    .sort((a, b) => b.staticSegments - a.staticSegments || a.params.length - b.params.length);

  const match = (
    pathname: string,
  ): { path: string; params: Record<string, string> } | undefined => {
    for (const p of patterns) {
      const m = p.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < p.params.length; i++)
        params[p.params[i] as string] = safeDecodeParam(m[i + 1] ?? "");
      return { path: p.path, params };
    }
    return undefined;
  };

  const prewarm = async (): Promise<void> => {
    const probe = new Request("http://localhost:0/prewarm", { method: "GET" });
    for (const ing of Object.values(compiled)) {
      if (ing) await ing.preprocess(probe);
    }
  };

  if (options.warmOnCreate) void prewarm();

  return { routeHandlers: compiled, routes: routeTable, match, prewarm };
};
