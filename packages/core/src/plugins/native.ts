/**
 * @fileoverview Native pre-flight plugin (opt-in, safe-by-default).
 *
 * Embeds castrum's Rust ingress pipeline (CORS, rate-limit, IP-trust,
 * body-guard, JSON-schema) as a request stage via
 * `@ignex/native#createNativePipeline` — the "route manager" bridge.
 *
 * When the Rust addon is NOT installed this plugin is a complete no-op and
 * the normal ignex lifecycle runs untouched, so it is safe to enable
 * everywhere. When native IS available, the 8-stage pipeline runs BEFORE the
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
   * default): when the pipeline provably cannot fire for a request — no
   * `rateLimit` configured, not a CORS preflight (`OPTIONS`), and no `Origin`
   * header — the Rust pipeline is skipped entirely and the request goes
   * straight to the handler. CORS can only fire on requests carrying an
   * `Origin` (or preflights), and without a rate limit there is nothing else
   * the pipeline decides for such a request (with `readBody: false` the
   * framework owns the body, so no body guards fire either). This removes the
   * per-request FFI crossing from the dominant plain-request path (~1.1µs
   * measured) while preserving every pipeline decision for the requests that
   * can trigger one. Set `false` to always run the pipeline (e.g. when you
   * rely on its URL/query-size guards for origin-less requests).
   */
  skipWhenSafe?: boolean;
}

const DEFAULT_CORS_METHODS = "GET, HEAD, PUT, PATCH, POST, DELETE";

/**
 * JS CORS preflight fallback used when the Rust addon is absent — parity with
 * castrum's wildcard preflight so the app's CORS contract holds without
 * native. Non-preflight requests pass through (the OK-path
 * `Access-Control-Allow-Origin: *` is served by the compiled server's static
 * default headers). Returns `ctx` when CORS is unconfigured or not a wildcard
 * preflight.
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
  // Wildcard allowlist → any origin allowed (no credentials).
  if (!(cors.allowOrigin?.some((o) => o === "*") ?? false)) return ctx;
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": cors.allowMethods?.join(", ") ?? DEFAULT_CORS_METHODS,
  };
  if (cors.maxAge != null) headers["access-control-max-age"] = String(cors.maxAge);
  return new Response(null, { status: 204, headers });
}

/**
 * Opt-in native pre-flight stage. Defaults to a no-op without the Rust addon.
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

  // exactOptionalPropertyTypes: only set `options`/`runtime` when defined,
  // so `undefined` is never passed for an optional field.
  const pipelineOptions = (): NativePipelineOptions => ({
    ...(mergedOptions !== undefined ? { options: mergedOptions } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
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
        (runtime as NativeIngressRuntime | undefined) ?? {},
      );
      if (direct) return direct;
    }
    return createNativePipeline(pipelineOptions());
  };

  return {
    name: "native-preflight",

    /**
     * Eagerly construct the Rust pipeline at boot (via `createApp.init()` /
     * `serve()`) instead of lazily on the first request. The cost is paid at
     * load time — the explicit trade the framework accepts. Without the addon
     * this is a no-op; a native failure never throws here.
     */
    async init() {
      if (!enabled || !isNativeAvailable()) return;
      if (pipeline === undefined) {
        pipeline = await resolvePipeline();
      }
    },

    onRequest(ctx: IgnexContext) {
      if (!enabled) return ctx;
      // Rust CORS preflight parity for fallback runs (no addon): answer
      // wildcard preflight in JS so the app's CORS contract holds everywhere.
      if (!isNativeAvailable()) return corsPreflightFallback(ctx, mergedOptions?.cors);

      if (pipeline === undefined) {
        // Eagerly resolved by `init()` at boot (createApp.serve and the
        // compiled server both run plugin init). If this fires (first request
        // before init, or direct `handler()` without init), resolve lazily
        // and return a Promise — runHooks awaits actual Promises, so the
        // steady-state sync fast path below stays microtask-free.
        return resolvePipeline().then((p) => {
          pipeline = p;
          if (!p) return ctx;
          const outcome = p.preprocess(ctx.req, p.needsIp ? ctx.ip : undefined);
          if (outcome instanceof Promise) {
            return outcome.then(({ terminal, response }) =>
              terminal && response ? response : ctx,
            );
          }
          const { terminal, response } = outcome;
          return terminal && response ? response : ctx;
        });
      }
      if (!pipeline) return ctx;

      // Fastest-path default: skip the Rust pipeline when it provably cannot
      // fire for this request — no rate limit configured (config-time), not a
      // CORS preflight, and no `Origin` header (CORS can only fire on a
      // request carrying an Origin). One `headers.get("origin")` (~34ns)
      // replaces the ~1.1µs FFI crossing on the dominant plain-request path;
      // requests that CAN trigger a pipeline decision still run it untouched.
      if (skipWhenSafe && !rateEnabled) {
        const origin = ctx.headers.get("origin");
        if (origin === null && ctx.method !== "OPTIONS") {
          return ctx;
        }
      }

      // Only resolve `ctx.ip` (a native `requestIP` socket lookup) when the
      // pipeline config needs it (rate-limit / trust-proxy); otherwise pass
      // `undefined` — a free fast path. The direct C-ABI path returns the
      // outcome synchronously (no Promise/microtask); the castrum-TS fallback
      // (readBody: true) returns a Promise, which runHooks awaits.
      const outcome = pipeline.preprocess(ctx.req, pipeline.needsIp ? ctx.ip : undefined);
      if (outcome instanceof Promise) {
        return outcome.then(({ terminal, response }) => (terminal && response ? response : ctx));
      }
      const { terminal, response } = outcome;
      // Returning a Response from onRequest short-circuits the lifecycle.
      return terminal && response ? response : ctx;
    },
  };
};
