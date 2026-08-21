/**
 * @fileoverview LEAN per-route native-stack responder (`nativeRouteHandler`).
 *
 * The route-wire v3 per-route stack (`createNativeRoute` over the
 * `castrum_route_*` C-ABI / napi `Route` surface) runs ONLY the stages the
 * plan compiled — `parseQuery` / `parseCookies` / `requireJsonBody` /
 * `validateBody` — in ONE native call, with NO CORS / rate-limit / security /
 * IP-trust / metadata envelope. This factory wraps a compiled route as a
 * Bun.serve-compatible handler: the native side returns a packed verdict +
 * pair sections, terminal verdicts become JSON rejections (400 for
 * `requireJsonBody`, 422 for `validateBody`), and on success the responder
 * builds the 2xx from the decoded snapshot.
 *
 * Synced from castrum's `src/ingress/routes/native.ts` + the router `native`
 * route kind (`src/ingress/router.ts`): measured ~580ns cheaper per request
 * than the full-pipeline responder on a parseQuery+parseCookies route
 * (`bench/cost/native-route-vs-router.ts`).
 *
 * Trade-off (deliberate): routes that need CORS / rate limiting / security
 * headers / IP trust must stay on the full pipeline (`createNativeIngress` /
 * `createNativePipeline`). This factory is for routes where the framework
 * owns the response body and only needs parse + verdict.
 */

import type { NativeRoute } from "./route";
import type { NativeRouteRunResult } from "./route-wire";
import { encoder } from "./util";

/** The decoded request snapshot handed to a lean native-stack responder. */
export interface NativeRouteSnapshot {
  /** Parsed query pairs as a last-wins record (`{}` when the plan has no `parseQuery`). */
  readonly query: Readonly<Record<string, string>>;
  /** Parsed cookie pairs as a last-wins record (`{}` when the plan has no `parseCookies`). */
  readonly cookies: Readonly<Record<string, string>>;
  /** Raw request body bytes (empty when the route did not read it). */
  readonly body: Uint8Array;
  /** The original `Request` (for headers / method / url access in the responder). */
  readonly req: Request;
}

/** Builds the 2xx response from a decoded native-route snapshot. */
export type NativeRouteResponder = (snapshot: NativeRouteSnapshot) => Response | Promise<Response>;

/** Options for {@link nativeRouteHandler}. */
export interface NativeRouteHandlerOptions {
  /** Read the request body and pass it for `requireJsonBody` / `validateBody`. Default `false`. */
  readBody?: boolean;
  /** Max body bytes before the body read fails (default 2 MiB). */
  maxBodyBytes?: number;
}

/** Error with a machine-readable `code` (mirrors the framework's body errors). */
interface CodedError extends Error {
  code?: string;
}

const codedError = (code: string, message: string): CodedError => {
  const err = new Error(message) as CodedError;
  err.code = code;
  return err;
};

/**
 * Bounded request-body read: the declared `content-length` is checked first
 * (no read when already over), then the buffered bytes are re-checked after
 * reading (a lying length never bypasses the cap). The native stack enforces
 * `maxBodyBytes` again on the frame, so this is a defensive first bound.
 */
async function readBodyBounded(req: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBodyBytes) {
    throw codedError("BODY_TOO_LARGE", "Request body is too large");
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBodyBytes) {
    throw codedError("BODY_TOO_LARGE", "Request body is too large");
  }
  return new Uint8Array(buf);
}

/** The `+`-to-space / `%XX` decoding is done natively; keys are last-wins. */
function pairsToRecord(pairs: ReadonlyArray<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
}

const TERMINAL_JSON = (status: number, code: string, message: string): Response =>
  new Response(encoder.encode(JSON.stringify({ ok: false, error: { code, message } })), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Map a native verdict failure to its JSON rejection (400/422, else 400). */
const terminalFor = (errorCode: number): Response => {
  if (errorCode === 400) {
    return TERMINAL_JSON(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  if (errorCode === 422) {
    return TERMINAL_JSON(422, "VALIDATION_FAILED", "Request body failed schema validation");
  }
  return TERMINAL_JSON(400, "BAD_REQUEST", "Bad request");
};

/**
 * Build a lean native-stack route handler over a COMPILED route (compile via
 * {@link createNativeRoute}, then pass the route here — the compilation
 * touches the dlopen layer, this factory stays pure).
 *
 * Terminal verdicts (`errorCode !== 0`) become JSON rejections: 400 for
 * `requireJsonBody` (missing / non-JSON body), 422 for `validateBody` schema
 * failure, 413 for an oversized body, 500 when the native run itself fails.
 * On success the responder builds the 2xx from the decoded snapshot.
 *
 * @example
 * ```ts
 * import { createNativeRoute, nativeRouteHandler } from "@ignex/native";
 *
 * const route = createNativeRoute({
 *   pipeline: ["parseQuery", "parseCookies"],
 *   schemas: {},
 *   maxBodyBytes: 2 * 1024 * 1024,
 *   maxQueryBytes: 8192,
 *   maxCookieBytes: 8192,
 *   maxPairs: 0,
 * });
 * const handler = nativeRouteHandler(route, (snap) =>
 *   Response.json({ ok: true, query: snap.query, cookies: snap.cookies }),
 * );
 * ```
 */
export function nativeRouteHandler(
  route: NativeRoute,
  responder: NativeRouteResponder,
  opts: NativeRouteHandlerOptions = {},
): (req: Request, server?: unknown) => Promise<Response> | Response {
  const readBody = opts.readBody ?? false;
  const maxBodyBytes = opts.maxBodyBytes ?? 2 * 1024 * 1024;
  const parseQuery = route.parseQuery;
  const parseCookies = route.parseCookies;

  return async (req) => {
    let body: Uint8Array | null = null;
    if (readBody) {
      try {
        body = await readBodyBounded(req, maxBodyBytes);
      } catch (err) {
        const code = (err as CodedError).code;
        const status = code === "BODY_TOO_LARGE" ? 413 : 400;
        return TERMINAL_JSON(status, "BAD_REQUEST", "Request body read failed");
      }
    }

    // Extract the query substring + Cookie header (the only request inputs the
    // native stack reads) and run the tiny frame in ONE native call.
    const url = req.url;
    const qIndex = url.indexOf("?");
    const queryStr = qIndex >= 0 ? url.slice(qIndex + 1) : "";
    const cookieStr = req.headers.get("cookie") ?? "";

    let result: NativeRouteRunResult;
    try {
      result = route.runParts(queryStr, cookieStr, body);
    } catch {
      return TERMINAL_JSON(500, "INTERNAL", "Native route run failed");
    }

    if (!result.ok || result.errorCode !== 0) {
      return terminalFor(result.errorCode);
    }

    return responder({
      query: parseQuery ? pairsToRecord(result.query) : {},
      cookies: parseCookies ? pairsToRecord(result.cookie) : {},
      body: body ?? new Uint8Array(0),
      req,
    });
  };
}
