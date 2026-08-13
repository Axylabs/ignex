/**
 * @fileoverview CORS plugin — Bun 1.4 hardened edition.
 */

import type { IgnusContext } from "../http/context";
import { appendVary, mutateHeaders } from "../http/headers";
import type { IgnusPlugin } from "../lifecycle/plugin";

/** Options for {@link cors}. */
export interface CorsOptions {
  origin?: string | string[] | ((origin: string, ctx: IgnusContext) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"];

/**
 * CORS plugin — adds `Access-Control-*` headers and answers preflight.
 *
 * @param options - Origin allowlist, methods, headers, credentials.
 * @throws Error when `origin: "*"` is combined with `credentials: true`
 * (a browser-forbidden, insecure combination).
 * @returns The CORS plugin.
 */
export const cors = (options: CorsOptions = {}): IgnusPlugin => {
  const {
    origin = "*",
    methods = DEFAULT_METHODS,
    allowedHeaders,
    exposedHeaders,
    credentials = false,
    maxAge = 86400,
    preflightContinue = false,
  } = options;

  if (origin === "*" && credentials) {
    throw new Error(
      "CORS misconfiguration: origin '*' cannot be used with credentials: true. Use an explicit origin allowlist.",
    );
  }

  const isOriginAllowed = (requestOrigin: string, ctx: IgnusContext): boolean => {
    if (origin === "*") return true;
    if (typeof origin === "string") return origin === requestOrigin;
    if (Array.isArray(origin)) return origin.includes(requestOrigin);
    return origin(requestOrigin, ctx);
  };

  // `requestOrigin` is pre-fetched by the caller (the onResponse gate fetches
  // it once) so the Origin header is not converted to a JS string twice.
  const setCorsHeaders = (ctx: IgnusContext, headers: Headers, requestOrigin?: string): void => {
    const originValue = requestOrigin ?? ctx.headers.get("origin") ?? "";
    // No Origin header → nothing to echo and nothing to vary on (matches
    // express-cors: `Vary: Origin` is only emitted when an Origin is present).
    if (!originValue) return;

    appendVary(headers, "Origin");

    if (isOriginAllowed(originValue, ctx)) {
      headers.set("Access-Control-Allow-Origin", originValue);

      if (credentials) {
        headers.set("Access-Control-Allow-Credentials", "true");
      }
    } else if (origin === "*" && !credentials) {
      headers.set("Access-Control-Allow-Origin", "*");
    }

    if (exposedHeaders?.length) {
      headers.set("Access-Control-Expose-Headers", exposedHeaders.join(", "));
    }
  };

  return {
    name: "cors",

    onRequest(ctx) {
      if (!ctx.headers.get("origin")) return ctx;

      if (ctx.method === "OPTIONS") {
        const headers = new Headers();

        setCorsHeaders(ctx, headers);
        headers.set("Access-Control-Allow-Methods", methods.join(", "));

        if (allowedHeaders?.length) {
          headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
        } else {
          const reqHeaders = ctx.headers.get("access-control-request-headers");

          if (reqHeaders) {
            headers.set("Access-Control-Allow-Headers", reqHeaders);
          }
        }

        headers.set("Access-Control-Max-Age", String(maxAge));

        if (preflightContinue) return ctx;

        return new Response(null, { status: 204, headers });
      }

      return ctx;
    },

    onResponse(ctx, response) {
      // Common path: no Origin header → nothing to echo, nothing to vary on.
      // Serve the response unchanged (no Headers copy, no re-wrap, no alloc)
      // instead of re-wrapping every response.
      const requestOrigin = ctx.headers.get("origin");
      if (!requestOrigin) return response;

      // Mutate the response's headers IN PLACE (Bun) — no re-wrap — so the
      // body stream + content-length are preserved across the plugin chain.
      return mutateHeaders(response, (headers) => {
        setCorsHeaders(ctx, headers, requestOrigin);
      });
    },
  };
};
