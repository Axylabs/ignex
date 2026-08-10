/**
 * @fileoverview Security headers plugin — Bun 1.4 edition.
 *
 * HSTS only on HTTPS requests.
 */

import type { FluxContext } from "../context";
import type { FluxPlugin } from "../plugin";

export interface SecurityOptions {
  contentSecurityPolicy?: string | false;
  crossOriginEmbedderPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  frameguard?: { action: "deny" | "sameorigin" } | false;
  hidePoweredBy?: boolean;
  hsts?: { maxAge?: number; includeSubDomains?: boolean; preload?: boolean } | false;
  noSniff?: boolean;
  referrerPolicy?: string | false;
  xssFilter?: boolean;
}

const DEFAULTS: SecurityOptions = {
  contentSecurityPolicy:
    "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' https: 'unsafe-inline'",
  crossOriginEmbedderPolicy: "require-corp",
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
  frameguard: { action: "deny" },
  hidePoweredBy: true,
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: true },
  noSniff: true,
  referrerPolicy: "no-referrer",
  xssFilter: true,
};

const isHttpsRequest = (ctx: FluxContext): boolean => {
  const forwardedProto = ctx.headers.get("x-forwarded-proto");

  if (forwardedProto && forwardedProto.toLowerCase().includes("https")) {
    return true;
  }

  try {
    return ctx.url.protocol === "https:";
  } catch {
    return false;
  }
};

export const security = (options: SecurityOptions = {}): FluxPlugin => {
  const opts = { ...DEFAULTS, ...options };

  return {
    name: "security",

    onResponse(ctx, response) {
      const headers = new Headers(response.headers);

      if (opts.contentSecurityPolicy) {
        headers.set("Content-Security-Policy", opts.contentSecurityPolicy);
      }

      if (opts.crossOriginEmbedderPolicy) {
        headers.set("Cross-Origin-Embedder-Policy", opts.crossOriginEmbedderPolicy);
      }

      if (opts.crossOriginOpenerPolicy) {
        headers.set("Cross-Origin-Opener-Policy", opts.crossOriginOpenerPolicy);
      }

      if (opts.crossOriginResourcePolicy) {
        headers.set("Cross-Origin-Resource-Policy", opts.crossOriginResourcePolicy);
      }

      if (opts.frameguard) {
        headers.set("X-Frame-Options", opts.frameguard.action.toUpperCase());
      }

      if (opts.hidePoweredBy) {
        headers.delete("X-Powered-By");
      }

      if (opts.hsts && isHttpsRequest(ctx)) {
        let value = `max-age=${opts.hsts.maxAge ?? 15552000}`;

        if (opts.hsts.includeSubDomains) {
          value += "; includeSubDomains";
        }

        if (opts.hsts.preload) {
          value += "; preload";
        }

        headers.set("Strict-Transport-Security", value);
      }

      if (opts.noSniff) {
        headers.set("X-Content-Type-Options", "nosniff");
      }

      if (opts.referrerPolicy) {
        headers.set("Referrer-Policy", opts.referrerPolicy);
      }

      if (opts.xssFilter) {
        headers.set("X-XSS-Protection", "0");
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
