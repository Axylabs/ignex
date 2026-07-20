/**
 * @fileoverview Security Headers Plugin — Defense in depth.
 */

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
  contentSecurityPolicy: "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' https: 'unsafe-inline'",
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

export const security = (options: SecurityOptions = {}): FluxPlugin => {
  const opts = { ...DEFAULTS, ...options };

  return {
    name: "security",
    onResponse(_ctx, response) {
      const h = response.headers;
      if (opts.contentSecurityPolicy) h.set("Content-Security-Policy", opts.contentSecurityPolicy);
      if (opts.crossOriginEmbedderPolicy) h.set("Cross-Origin-Embedder-Policy", opts.crossOriginEmbedderPolicy);
      if (opts.crossOriginOpenerPolicy) h.set("Cross-Origin-Opener-Policy", opts.crossOriginOpenerPolicy);
      if (opts.crossOriginResourcePolicy) h.set("Cross-Origin-Resource-Policy", opts.crossOriginResourcePolicy);
      if (opts.frameguard) h.set("X-Frame-Options", opts.frameguard.action.toUpperCase());
      if (opts.hidePoweredBy) h.delete("X-Powered-By");
      if (opts.hsts) {
        let val = `max-age=${opts.hsts.maxAge ?? 15552000}`;
        if (opts.hsts.includeSubDomains) val += "; includeSubDomains";
        if (opts.hsts.preload) val += "; preload";
        h.set("Strict-Transport-Security", val);
      }
      if (opts.noSniff) h.set("X-Content-Type-Options", "nosniff");
      if (opts.referrerPolicy) h.set("Referrer-Policy", opts.referrerPolicy);
      if (opts.xssFilter) h.set("X-XSS-Protection", "0");
      return response;
    },
  };
};