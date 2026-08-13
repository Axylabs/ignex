/**
 * @fileoverview Native pre-flight plugin (opt-in, safe-by-default).
 *
 * Embeds castrum's Rust ingress pipeline (CORS, rate-limit, IP-trust,
 * body-guard, JSON-schema) as a request stage via
 * `@ignus/native#createNativePipeline` — the "route manager" bridge.
 *
 * When the Rust addon is NOT installed this plugin is a complete no-op and
 * the normal ignus lifecycle runs untouched, so it is safe to enable
 * everywhere. When native IS available, the 8-stage pipeline runs BEFORE the
 * app handler on `onRequest` and short-circuits with its terminal response
 * (e.g. 204 CORS preflight, 429, 413, 400/422) when it decides to.
 */

import {
  createNativePipeline,
  isNativeAvailable,
  type NativeCorsOptions,
  type NativeIngressOptions,
  type NativePipeline,
  type NativePipelineOptions,
  type NativeRateLimitOptions,
} from "@ignus/native";
import type { IgnusContext } from "../http/context";
import type { IgnusPlugin } from "../lifecycle/plugin";

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
}

/**
 * Opt-in native pre-flight stage. Defaults to a no-op without the Rust addon.
 */
export const nativePreflight = (opts: NativePreflightOptions = {}): IgnusPlugin => {
  const { options, runtime, enabled = true, readBody = false, rateLimit, cors } = opts;
  // Merge the top-level rate-limit/CORS conveniences into the ingress option
  // bag (top-level wins on conflict) so the pipeline is configured in one place.
  const mergedOptions: NativeIngressOptions | undefined =
    options || rateLimit || cors
      ? { ...options, ...(rateLimit ? { rateLimit } : {}), ...(cors ? { cors } : {}) }
      : undefined;
  // `undefined` = not yet resolved; `null` = unavailable.
  let pipeline: NativePipeline | null | undefined;

  // exactOptionalPropertyTypes: only set `options`/`runtime` when defined,
  // so `undefined` is never passed for an optional field.
  const pipelineOptions = (): NativePipelineOptions => ({
    ...(mergedOptions !== undefined ? { options: mergedOptions } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
    readBody,
  });

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
        pipeline = await createNativePipeline(pipelineOptions());
      }
    },

    async onRequest(ctx: IgnusContext) {
      if (!enabled || !isNativeAvailable()) return ctx;

      if (pipeline === undefined) {
        pipeline = await createNativePipeline(pipelineOptions());
      }
      if (!pipeline) return ctx;

      const { terminal, response } = await pipeline.preprocess(ctx.req, ctx.ip);
      // Returning a Response from onRequest short-circuits the lifecycle.
      return terminal && response ? response : ctx;
    },
  };
};
