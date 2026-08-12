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

import { createNativePipeline, isNativeAvailable, type NativePipeline } from "@ignus/native";
import type { IgnusContext } from "../http/context";
import type { IgnusPlugin } from "../lifecycle/plugin";

export interface NativePreflightOptions {
  /**
   * Ingress options passed through to castrum's `createPipeline`
   * (e.g. `cors`, `rateLimit`, `schema`, `limits`).
   */
  options?: Record<string, unknown>;
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
  const { options, enabled = true, readBody = false } = opts;
  // `undefined` = not yet resolved; `null` = unavailable.
  let pipeline: NativePipeline | null | undefined;

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
        pipeline = await createNativePipeline({ options, readBody });
      }
    },

    async onRequest(ctx: IgnusContext) {
      if (!enabled || !isNativeAvailable()) return ctx;

      if (pipeline === undefined) {
        pipeline = await createNativePipeline({ options, readBody });
      }
      if (!pipeline) return ctx;

      const { terminal, response } = await pipeline.preprocess(ctx.req, ctx.ip);
      // Returning a Response from onRequest short-circuits the lifecycle.
      return terminal && response ? response : ctx;
    },
  };
};
