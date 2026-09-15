/**
 * @fileoverview Security headers plugin — Bun 1.4 edition.
 *
 * HSTS only on HTTPS requests.
 */

import type { IgnexContext } from "../http/context";
import { isDecoratedResponse } from "../http/finalize";
import { mutateHeaders } from "../http/headers";
import { getServeBootInfo } from "../http/serve-boot";
import type { IgnexPlugin } from "../lifecycle/plugin";

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
  /**
   * Trust the client-supplied `x-forwarded-proto` header when deciding
   * whether HSTS applies. Default `false` — the header is spoofable, so
   * HSTS is decided from the actual request scheme unless the app sits
   * behind a proxy that overwrites it. Matches the framework-wide
   * `trustProxy` discipline (ctx.ip, rate limiting).
   */
  trustProxy?: boolean;
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

const isHttpsRequest = (ctx: IgnexContext, trustProxy: boolean): boolean => {
  if (trustProxy) {
    const forwardedProto = ctx.headers.get("x-forwarded-proto");

    if (forwardedProto?.toLowerCase().includes("https")) {
      return true;
    }
  }

  // The LISTENER protocol is fixed at boot (`setServeBootInfo` runs before any
  // plugin, and before the first request), so read it instead of the request
  // URL. This is not a micro-optimisation — it removes a real cost:
  //
  // Reading `req.url` was measured at **248ns on the FIRST access per request**
  // (~218ns net of the timer) versus ~9ns cached. Bun materialises the URL
  // string lazily, and on the `Bun.serve({routes})` path route matching happens
  // in Rust, so nothing has materialised it by the time the handler runs. An
  // earlier measurement of this same expression read `req.url` 300,000 times
  // inside ONE handler, which amortised the materialisation to nothing and
  // reported 8ns — misleading everyone who relied on it.
  //
  // On the benchmark's routes this HSTS check was the ONLY reader of `req.url`,
  // so consulting the boot protocol removes the materialisation from the request
  // path entirely.
  const boot = getServeBootInfo();
  if (boot) return boot.protocol === "https";

  // No boot info (interpreted `createApp` used without `serve()`): fall back to
  // the URL scheme.
  return ctx.req.url.startsWith("https:");
};

/**
 * Security headers plugin — CSP, HSTS, frame protection, no-sniff, etc.
 *
 * @param options - Header overrides; each defaults to a hardened value.
 * @returns The security plugin.
 */
export const security = (options: SecurityOptions = {}): IgnexPlugin => {
  const opts = { ...DEFAULTS, ...options };
  const trustProxy = opts.trustProxy ?? false;

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

  // The HSTS header VALUE is a boot-time constant. Building it inside
  // `onResponse` ran three string concatenations on every HTTPS response.
  const hstsHeaderValue: string | undefined = hsts
    ? `max-age=${hsts.maxAge ?? 15552000}` +
      (hsts.includeSubDomains ? "; includeSubDomains" : "") +
      (hsts.preload ? "; preload" : "")
    : undefined;

  // Whether HSTS applies is resolved as cheaply as it can be:
  //
  // * Without `trustProxy` the answer depends only on the SERVER's scheme —
  //   every request to an HTTP server carries an `http:` URL — so the probe
  //   runs ONCE and is memoized, instead of reading `ctx.req.url` and running
  //   `startsWith("https:")` on every response.
  // * With `trustProxy` it is derived from `x-forwarded-proto`, is genuinely
  //   per-request, and stays on the hot path.
  // * With HSTS disabled the whole thing folds away.
  let serverIsHttps: boolean | undefined;
  const hstsForRequest = (ctx: IgnexContext): string | undefined => {
    if (hstsHeaderValue === undefined) return undefined;
    if (trustProxy) return isHttpsRequest(ctx, true) ? hstsHeaderValue : undefined;

    serverIsHttps ??= isHttpsRequest(ctx, false);
    return serverIsHttps ? hstsHeaderValue : undefined;
  };

  // Declarative copy of the static header set. The framework bakes these into
  // the header record when it CONSTRUCTS a response (`ctx.json`/`text`/`html`),
  // which replaces the plugin's per-response chain of 8 native `Headers.set`
  // calls with a single object build. HSTS is deliberately NOT included — it
  // is request-conditional (HTTPS only) and stays on the `onResponse` path.
  const responseDefaults: Record<string, string> = {};
  for (const [k, v] of baked) responseDefaults[k] = v;

  return {
    name: "security",
    responseDefaults: Object.freeze(responseDefaults),
    // `trustProxy` means "forwarded headers are authoritative for this
    // deployment" — which is precisely what `ctx.ip` needs to know, not just
    // this plugin's own HSTS decision. Declaring it is what carries it into the
    // context on BOTH paths (see `IgnexPlugin.contextOptions`); the option used
    // to influence `isHttpsRequest` alone.
    ...(trustProxy ? { contextOptions: { trustProxy: true } } : {}),

    onResponse(ctx, response) {
      // Conditional headers, resolved by `hstsForRequest` — a memoized
      // server-level probe when the app does not trust a proxy.
      const hstsValue = hstsForRequest(ctx);

      // Fast path: a response the framework built already carries the static
      // header set (baked in at construction — see `isDecoratedResponse`).
      // When HSTS does not apply (plain HTTP), there is nothing left to do at
      // all, so this collapses to a single `WeakSet` probe.
      //
      // `hidePoweredBy` is intentionally skipped here: the framework never
      // adds `X-Powered-By` to a response it constructs, and a value the app
      // sets through `ctx.set.headers` is applied by the later `applySet` pass
      // — AFTER this hook — so the delete could never have removed it anyway.
      // Only a raw `Response` passthrough (handled below) can carry one.
      if (isDecoratedResponse(response)) {
        if (hstsValue === undefined) return response;

        return mutateHeaders(response, (headers) => {
          headers.set("Strict-Transport-Security", hstsValue);
        });
      }

      // Apply the security headers IN PLACE (Bun) — no Headers copy, no
      // re-wrap — so the body stream + content-length survive the chain and
      // the per-request re-wrap cost (~2.5-4µs) disappears.
      return mutateHeaders(response, (headers) => {
        for (const [k, v] of baked) {
          // Respect a Content-Security-Policy the app/route already set on the
          // response (e.g. the `openapi()` docs page, which must allow its CDN
          // bundles). A response-level CSP is more specific than the global
          // default; overwriting it would break such pages.
          if (k === "Content-Security-Policy" && headers.has("Content-Security-Policy")) {
            continue;
          }
          headers.set(k, v);
        }

        if (hidePoweredBy) {
          headers.delete("X-Powered-By");
        }

        if (hstsValue !== undefined) {
          headers.set("Strict-Transport-Security", hstsValue);
        }
      });
    },
  };
};
