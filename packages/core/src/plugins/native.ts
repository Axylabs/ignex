/**
 * @fileoverview Native pre-flight plugin (opt-in, safe-by-default).
 *
 * Embeds castrum's Rust ingress pipeline (CORS, rate-limit, IP-trust,
 * body-guard, JSON-schema) as a request stage via
 * `@ignex/native#createNativePipeline` — the "route manager" bridge.
 *
 * Without configuration this plugin is a no-op when native is absent. CORS
 * preflight has a TypeScript fallback; other configured enforcement fails closed
 * with 503 when native is unavailable or cannot produce a verdict. When native
 * is available, the 8-stage pipeline runs BEFORE the
 * app handler on `onRequest` and short-circuits with its terminal response
 * (e.g. 204 CORS preflight, 429, 413, 400/422) when it decides to.
 */

import {
  createNativeIngress,
  createNativePipeline,
  isNativeAvailable,
  type NativeCorsOptions,
  type NativeIngressOptions,
  type NativeIngressRuntime,
  type NativePipeline,
  type NativePipelineOptions,
  type NativeRateLimitOptions,
} from "@ignex/native";
import type { IgnexContext } from "../http/context";
import type { IgnexPlugin } from "../lifecycle/plugin";

/** Options for {@link nativePreflight}. */
export interface NativePreflightOptions {
  /**
   * Ingress options passed through to castrum's `createPipeline`
   * (e.g. `schema`, `limits`, `trustedProxies`, `parseCookies`, `parseQuery`).
   * For rate limiting and CORS prefer the top-level `rateLimit` / `cors`
   * conveniences below.
   */
  options?: NativeIngressOptions;
  /**
   * Top-level convenience: enable the pipeline's Rust fixed-window rate-limit
   * stage — one FFI call, terminal 429 fully served from Rust. Single-owner
   * contract: do NOT also enable the `rateLimit` plugin's `native: true` for
   * the same budget, or requests would be double-charged. Use the `rateLimit`
   * plugin instead for custom `keyGenerator`s or the sliding-window /
   * token-bucket algorithms (TS-only).
   */
  rateLimit?: NativeRateLimitOptions;
  /**
   * Top-level convenience: enable the pipeline's Rust CORS stage. OPTIONS
   * preflight is answered entirely in Rust (terminal 204 echoing the allowed
   * origin + baked security headers; 403 for denied origins). The OK-path
   * `access-control-*` echo still comes from the JS `cors()` plugin (dynamic
   * origins / expose headers). When both are enabled, the pipeline runs first
   * and short-circuits preflight.
   */
  cors?: NativeCorsOptions;
  /**
   * Runtime hooks passed through to castrum's `createPipeline` — notably
   * `securityHeaders` (`[name, value][]`), which pre-bakes the app's security
   * headers into the pipeline's terminal/error templates at construction, so
   * terminal responses (413, 400/422, 429, CORS-forbidden) carry them from Rust
   * without a JS lifecycle round-trip.
   */
  runtime?: Record<string, unknown>;
  /** When `false` the plugin is a no-op (default `true`). */
  enabled?: boolean;
  /**
   * When `true` the pipeline reads the request body (guarded). Default
   * `false`: the framework owns the body, so the pipeline must not consume it
   * (castrum's createPipeline reads the body by default).
   */
  readBody?: boolean;
  /**
   * Fastest-path default (the framework's philosophy: the fastest path IS the
   * default): when the pipeline provably cannot change the outcome for a
   * request, the Rust pipeline is skipped entirely and the request goes
   * straight to the handler. Two cases skip today:
   *
   *   1. **No `Origin`** (and not `OPTIONS`) — CORS can only fire on requests
   *      carrying an `Origin` or on preflights;
   *   2. **Allowlisted `Origin`** (and not `OPTIONS`) — the pipeline's verdict
   *      for such a request is a non-terminal "allow", and only a TERMINAL
   *      response consumes the native verdict (the OK-path `access-control-*`
   *      echo is owned by the JS `cors()` plugin / Bun's default header sink).
   *      Measured: skipping removes ~2.6µs per request on a small payload and
   *      ~10.7µs on a 60-param one.
   *
   * Case 2 applies only while CORS is the pipeline's ONLY decision stage — any
   * `rateLimit`, `schema`/`requireJsonBody`/`enableBodySizeGuard`, or
   * trust-proxy config keeps the pipeline live for every request. Set `false`
   * to always run the pipeline (e.g. when you rely on its URL/query-size
   * guards for origin-bearing requests).
   */
  skipWhenSafe?: boolean;
}

const DEFAULT_CORS_METHODS = "GET, HEAD, PUT, PATCH, POST, DELETE";

/**
 * JS CORS preflight fallback used when the Rust addon is absent. Allowlisted
 * and wildcard origins retain the 204 contract; denied origins are rejected
 * instead of falling through to an application handler.
 */
function corsPreflightFallback(
  ctx: IgnexContext,
  cors: NativeCorsOptions | undefined,
): IgnexContext | Response {
  if (!cors) return ctx;
  const origin = ctx.headers.get("origin");
  if (!origin) return ctx;
  if (ctx.method !== "OPTIONS") return ctx;
  if (!ctx.headers.get("access-control-request-method")) return ctx;
  const wildcard = cors.allowOrigin?.includes("*") ?? false;
  if (!wildcard && !cors.allowOrigin?.includes(origin)) {
    return Response.json(
      { error: "CORS origin denied", status: 403, code: "CORS_ORIGIN_DENIED" },
      { status: 403 },
    );
  }
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": cors.allowMethods?.join(", ") ?? DEFAULT_CORS_METHODS,
  };
  if (cors.allowHeaders) headers["access-control-allow-headers"] = cors.allowHeaders.join(", ");
  if (cors.allowCredentials) headers["access-control-allow-credentials"] = "true";
  if (cors.maxAge != null) headers["access-control-max-age"] = String(cors.maxAge);
  return new Response(null, { status: 204, headers });
}

const nativePreflightUnavailable = (): Response =>
  Response.json(
    {
      error: "Security pipeline unavailable",
      status: 503,
      code: "NATIVE_PREFLIGHT_UNAVAILABLE",
    },
    {
      status: 503,
      headers: { "retry-after": "1", "x-ignex-reason": "native-preflight-unavailable" },
    },
  );

/**
 * Opt-in native pre-flight stage. Unconfigured use is a no-op without the addon;
 * configured enforcement fails closed when no trustworthy verdict is available.
 */
export const nativePreflight = (opts: NativePreflightOptions = {}): IgnexPlugin => {
  const {
    options,
    runtime,
    enabled = true,
    readBody = false,
    rateLimit,
    cors,
    skipWhenSafe = true,
  } = opts;
  // Merge the top-level rate-limit/CORS conveniences into the ingress option
  // bag (top-level wins on conflict) so the pipeline is configured in one place.
  const mergedOptions: NativeIngressOptions | undefined =
    options || rateLimit || cors
      ? { ...options, ...(rateLimit ? { rateLimit } : {}), ...(cors ? { cors } : {}) }
      : undefined;
  // `undefined` = not yet resolved; `null` = unavailable.
  let pipeline: NativePipeline | null | undefined;

  // Config-time: can the pipeline EVER fire for an origin-less non-preflight
  // request? Only a configured rate limit makes it matter (CORS needs an
  // `Origin` / preflight; with `readBody: false` the framework owns the body).
  // When false, `skipWhenSafe` short-circuits onRequest without the FFI call.
  const rateEnabled = mergedOptions?.rateLimit != null;

  // Config-time: does the pipeline decide anything on the OK path for an
  // origin-bearing request? Only a TERMINAL response consumes the native
  // verdict; a non-terminal "allow" is dropped (the OK-path CORS echo is owned
  // by the JS `cors()` plugin / Bun's default header sink). So when CORS is the
  // ONLY configured stage, running the pipeline for a request whose origin the
  // allowlist accepts buys nothing — while any other stage (rate limit, schema,
  // body/JSON guard, trust proxy) must keep it live. See `skipWhenSafe`.
  const pipelineDecidesMore =
    rateEnabled ||
    readBody ||
    mergedOptions?.schema !== undefined ||
    mergedOptions?.requireJsonBody === true ||
    mergedOptions?.enableBodySizeGuard === true ||
    mergedOptions?.trustProxy === true ||
    mergedOptions?.trustedProxies?.enabled === true;
  const corsAllowOrigin = mergedOptions?.cors?.allowOrigin;
  const corsWildcard = corsAllowOrigin?.includes("*") ?? false;
  // Exact-match set (null when the wildcard short-circuits it). Mirrors
  // castrum's allowlist match — a value NOT matched here keeps the pipeline
  // live, so a deny is never skipped.
  const corsExact = corsWildcard ? null : new Set(corsAllowOrigin ?? []);
  /** True when the configured allowlist DEFINITELY accepts `origin`. */
  const originAllowed = (origin: string): boolean =>
    corsWildcard || (corsExact?.has(origin) ?? false);

  const hasPipelineOptions = mergedOptions !== undefined;
  const needsNativeEnforcement =
    hasPipelineOptions && Object.keys(mergedOptions).some((key) => key !== "cors");
  const effectiveRuntime = hasPipelineOptions
    ? { ...(runtime as NativeIngressRuntime | undefined), failClosed: true }
    : runtime;

  // exactOptionalPropertyTypes: only set `options`/`runtime` when defined,
  // so `undefined` is never passed for an optional field.
  const pipelineOptions = (): NativePipelineOptions => ({
    ...(mergedOptions !== undefined ? { options: mergedOptions } : {}),
    ...(effectiveRuntime !== undefined ? { runtime: effectiveRuntime } : {}),
    readBody,
  });

  /**
   * Resolve the pre-flight pipeline, preferring the DIRECT C-ABI ingress path
   * (`createNativeIngress` — one `castrum_ingress_handle_components` call with
   * `cstring` url/ip, zero JS encode/decode, no castrum TS-layer round trip)
   * when the framework owns the body (`readBody: false`). When `readBody` is
   * true (the pipeline must consume the stream itself) we fall back to
   * castrum's `createPipeline`, which is the only path that reads bodies.
   */
  const resolvePipeline = async (): Promise<NativePipeline | null> => {
    if (!readBody) {
      const direct = createNativeIngress(
        mergedOptions,
        (effectiveRuntime as NativeIngressRuntime | undefined) ?? {},
      );
      if (direct) return direct;
    }
    return createNativePipeline(pipelineOptions());
  };

  return {
    name: "native-preflight",

    /**
     * Eagerly construct the Rust pipeline at boot. Request handling fails
     * closed if configured enforcement is unavailable or cannot return a verdict.
     */
    async init() {
      if (!enabled || !isNativeAvailable()) return;
      if (pipeline === undefined) {
        pipeline = await resolvePipeline();
      }
    },

    onRequest(ctx: IgnexContext) {
      if (!enabled) return ctx;
      if (!isNativeAvailable()) {
        if (needsNativeEnforcement) return nativePreflightUnavailable();
        return corsPreflightFallback(ctx, mergedOptions?.cors);
      }

      const runPipeline = (
        active: NativePipeline,
      ): IgnexContext | Response | Promise<IgnexContext | Response> => {
        const finish = (outcome: {
          terminal: boolean;
          response: Response | null;
          result: unknown;
        }): IgnexContext | Response => {
          if (outcome.terminal && outcome.response) return outcome.response;
          if (hasPipelineOptions && outcome.result === null) {
            return nativePreflightUnavailable();
          }
          return ctx;
        };
        try {
          const outcome = active.preprocess(ctx.req, active.needsIp ? ctx.ip : undefined);
          if (outcome instanceof Promise) {
            return outcome.then(finish, nativePreflightUnavailable);
          }
          return finish(outcome);
        } catch {
          return nativePreflightUnavailable();
        }
      };

      if (pipeline === undefined) {
        return resolvePipeline().then((resolved) => {
          pipeline = resolved;
          if (!resolved) {
            return hasPipelineOptions ? nativePreflightUnavailable() : ctx;
          }
          return runPipeline(resolved);
        });
      }
      if (!pipeline) return hasPipelineOptions ? nativePreflightUnavailable() : ctx;

      // Fastest-path default: skip the Rust pipeline when it cannot change the
      // outcome — not a preflight, and either no `Origin` at all or an origin
      // the configured CORS allowlist accepts while CORS is the only decision
      // stage (see `skipWhenSafe`). One `headers.get("origin")` (~34ns)
      // replaces a full native crossing on the dominant request paths;
      // requests that CAN trigger a pipeline decision still run it untouched.
      if (skipWhenSafe && !rateEnabled && ctx.method !== "OPTIONS") {
        const origin = ctx.headers.get("origin");
        if (origin === null) return ctx;
        if (!pipelineDecidesMore && originAllowed(origin)) return ctx;
      }

      return runPipeline(pipeline);
    },
  };
};
