/**
 * bench/compare/servers/ignus-aot-app/src/lib/bench.ts
 *
 * Shared helpers for the AOT-compiled comparison participant.
 *
 * Every route delegates to the SAME helpers the interpreted ignus server uses
 * (`bench/compare/shared.ts`) so the per-request work is byte-identical. The
 * one deliberate difference: routes reply with `ctx.json(...)` (the compiled
 * `jsonReply` / `IgnexContextImpl.json` path — one TextEncoder pass + exact
 * content-length) instead of the interpreted server's
 * `new Response(JSON.stringify(...))` passthrough. That difference is exactly
 * what the `ignus-aot` participant exists to measure.
 *
 * NOTE on codegen: the compiled route keeps its FULL context only when the
 * usage analyzer sees a direct `ctx.*` access in the handler body — passing
 * `ctx` to these helpers does NOT count (they run at runtime with the real
 * context). Each route therefore inlines the `ctx.set.headers[…]` writes so
 * `usage.set` is detected and the full context (set/requestId/ip/cookie/body/
 * url/req) is materialized.
 */
import type { IgnexContext } from "@ignex/core";
import {
  parseQuery,
  RATE_LIMIT_CONFIG,
  rateLimitCheck,
  validateUserBody,
} from "../../../../shared";

export type BenchCtx = IgnexContext;

// Re-export the shared rate-limit pieces so routes import everything from
// `../lib/bench` (single import site per route).
export { RATE_LIMIT_CONFIG, rateLimitCheck, validateUserBody };

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

export const okEnvelope = (
  ctx: BenchCtx,
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

export const errorEnvelope = (error: {
  code: string;
  message: string;
  retry_after_ms?: number;
}): ApiError => ({ ok: false, error });

/** Parse the request query into a grouped record (URLSearchParams-based). */
export const queryRecord = (ctx: BenchCtx): Record<string, string | string[]> =>
  parseQuery(ctx.url);

/** Collect the request cookies into a plain record. */
export const cookiesRecord = (ctx: BenchCtx): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, cookie] of Object.entries(ctx.cookie)) {
    out[key] = cookie.value ?? "";
  }
  return out;
};

/**
 * Shared POST/PUT/PATCH `/api/users` body handling — content-type guard
 * (415) → JSON parse (400) → schema validation (422) → echo envelope. Mirrors
 * the interpreted server's route exactly.
 */
export const usersBodyRoute = async (ctx: BenchCtx): Promise<Response> => {
  const contentType = ctx.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return ctx.json(
      errorEnvelope({
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
    return ctx.json(errorEnvelope({ code: "invalid_json", message: "Invalid JSON body" }), {
      status: 400,
    });
  }

  const validationError = validateUserBody(parsed);
  if (validationError) {
    return ctx.json(errorEnvelope({ code: "schema_validation_failed", message: validationError }), {
      status: 422,
    });
  }

  return ctx.json(okEnvelope(ctx, "/api/users", queryRecord(ctx), cookiesRecord(ctx), parsed));
};
