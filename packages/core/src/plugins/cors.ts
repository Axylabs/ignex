/**
 * @fileoverview CORS plugin — Bun 1.4 hardened edition.
 */

import type { FluxContext } from "../http/context";
import { appendVary, reWrapResponse } from "../http/headers";
import type { FluxPlugin } from "../lifecycle/plugin";

export interface CorsOptions {
  origin?: string | string[] | ((origin: string, ctx: FluxContext) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"];

export const cors = (options: CorsOptions = {}): FluxPlugin => {
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

  const isOriginAllowed = (requestOrigin: string, ctx: FluxContext): boolean => {
    if (origin === "*") return true;
    if (typeof origin === "string") return origin === requestOrigin;
    if (Array.isArray(origin)) return origin.includes(requestOrigin);
    return origin(requestOrigin, ctx);
  };

  const setCorsHeaders = (ctx: FluxContext, headers: Headers): void => {
    appendVary(headers, "Origin");

    const requestOrigin = ctx.headers.get("origin") || "";
    if (!requestOrigin) return;

    if (isOriginAllowed(requestOrigin, ctx)) {
      headers.set("Access-Control-Allow-Origin", requestOrigin);

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
      const headers = new Headers(response.headers);
      setCorsHeaders(ctx, headers);

      return reWrapResponse(response, { headers });
    },
  };
};
