/**
 * @fileoverview Security headers plugin — Bun 1.4 edition.
 *
 * HSTS only on HTTPS requests.
 */

import type { IgnusContext } from "../http/context";
import { mutateHeaders } from "../http/headers";
import type { IgnusPlugin } from "../lifecycle/plugin";

/** Options for {@link security}. */
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

const isHttpsRequest = (ctx: IgnusContext): boolean => {
  const forwardedProto = ctx.headers.get("x-forwarded-proto");

  if (forwardedProto?.toLowerCase().includes("https")) {
    return true;
  }

  // Avoid materializing `new URL(req.url)` (allocation + full parse) just to
  // read the scheme — the request URL string is already available and this is
  // on the per-response hot path.
  return ctx.req.url.startsWith("https:");
};

/**
 * Security headers plugin — CSP, HSTS, frame protection, no-sniff, etc.
 *
 * @param options - Header overrides; each defaults to a hardened value.
 * @returns The security plugin.
 */
export const security = (options: SecurityOptions = {}): IgnusPlugin => {
  const opts = { ...DEFAULTS, ...options };

  // Pre-bake the per-request-invariant security headers ONCE (frozen array),
  // so the per-response path just iterates pairs instead of re-evaluating
  // every option + building header strings on each request. Only HSTS (https-
  // conditional) and the X-Powered-By delete stay per-request.
  const baked: ReadonlyArray<[string, string]> = Object.freeze(
    [
      opts.contentSecurityPolicy ? ["Content-Security-Policy", opts.contentSecurityPolicy] : null,
      opts.crossOriginEmbedderPolicy
        ? ["Cross-Origin-Embedder-Policy", opts.crossOriginEmbedderPolicy]
        : null,
      opts.crossOriginOpenerPolicy
        ? ["Cross-Origin-Opener-Policy", opts.crossOriginOpenerPolicy]
        : null,
      opts.crossOriginResourcePolicy
        ? ["Cross-Origin-Resource-Policy", opts.crossOriginResourcePolicy]
        : null,
      opts.frameguard ? ["X-Frame-Options", opts.frameguard.action.toUpperCase()] : null,
      opts.noSniff ? ["X-Content-Type-Options", "nosniff"] : null,
      opts.referrerPolicy ? ["Referrer-Policy", opts.referrerPolicy] : null,
      opts.xssFilter ? ["X-XSS-Protection", "0"] : null,
    ].filter((x): x is [string, string] => x !== null),
  );
  const hidePoweredBy = opts.hidePoweredBy;
  const hsts = opts.hsts;

  return {
    name: "security",

    onResponse(ctx, response) {
      // Apply the security headers IN PLACE (Bun) — no Headers copy, no
      // re-wrap — so the body stream + content-length survive the chain and
      // the per-request re-wrap cost (~2.5-4µs) disappears.
      return mutateHeaders(response, (headers) => {
        for (const [k, v] of baked) {
          headers.set(k, v);
        }

        if (hidePoweredBy) {
          headers.delete("X-Powered-By");
        }

        if (hsts && isHttpsRequest(ctx)) {
          let value = `max-age=${hsts.maxAge ?? 15552000}`;

          if (hsts.includeSubDomains) {
            value += "; includeSubDomains";
          }

          if (hsts.preload) {
            value += "; preload";
          }

          headers.set("Strict-Transport-Security", value);
        }
      });
    },
  };
};
