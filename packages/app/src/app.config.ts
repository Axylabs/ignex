/**
 * Ignex application configuration.
 *
 * The compiler reads this file at build time and merges `plugins`, `lifecycle`
 * and `server` into the generated `Bun.serve` entry.
 */
import {
  compression,
  createI18n,
  debugbar,
  type IgnexPlugin,
  nativePreflight,
  openapi,
  session,
} from "@ignex/core";
import { env } from "./config/env.js";
import { middleware } from "./middleware/index.js";
import { logRequests, markResponse } from "./middleware/log-requests.js";

export const plugins: IgnexPlugin[] = [
  // Custom global plugins (see src/middleware/) — run on every request.
  ...middleware,
  compression(),
  // Developer debug dashboard (traces, waterfall, errors + replay, system
  // profile, SDK list, KT docs) at `/__debugbar`. Registered only when the
  // app runs with DEBUG=true (see src/config/env.ts / packages/app/.env).
  // `enabled: true` makes DEBUG authoritative — the dashboard comes up even
  // when the shell exports NODE_ENV=production, which would otherwise
  // self-disable the plugin's debug-mode default.
  ...(env.DEBUG ? [debugbar({ enabled: true, serviceName: "ignex-app" })] : []),
  // Lazy sessions: `createIfMissing: "lazy"` defers session creation until a
  // handler actually reads it (via `getSession`), so requests that never use
  // a session (health checks, static routes, most APIs) do ZERO session work —
  // no id generation, no cookie signing, no `Set-Cookie` on the response.
  // `rolling: false` avoids re-signing the cookie on every request that merely
  // carries a valid session; the cookie is only rewritten when data changes.
  session({
    secret: env.SESSION_SECRET ?? "dev-secret-change-me",
    createIfMissing: "lazy",
    rolling: false,
  }),
  // Native pre-flight pipeline (castrum Rust ingress): ONE FFI call per request
  // owns CORS (wildcard preflight + forbidden, browser-accurate via
  // access-control-request-method) and the URL/header/query limits, and bakes
  // `securityHeaders` into terminal/error responses. The OK-path static
  // security headers + `Access-Control-Allow-Origin: *` are served natively by
  // Bun's `server.headers` default sink (see `server` below) — zero per-request
  // JS for CORS/security. `compression()` stays JS (Bun's gzip beats the Rust
  // gzip on this workload); `session()` stays JS (app store logic; its crypto
  // is already native via FFI). `readBody` stays false so the framework owns
  // the request body. A safe no-op when the Rust addon is absent.
  nativePreflight({
    cors: {
      allowOrigin: ["*"],
      allowMethods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
      maxAge: 86400,
    },
    runtime: {
      // Baked into castrum's terminal/error header templates (frameOptions,
      // nosniff, referrerPolicy). HSTS is deliberately excluded: it is HTTPS-
      // only and belongs at the TLS-terminating proxy.
      securityHeaders: [
        ["x-frame-options", "DENY"],
        ["x-content-type-options", "nosniff"],
        ["referrer-policy", "no-referrer"],
      ],
    },
  }),
  // OpenAPI docs — `GET /openapi.json` (spec) + `GET /openapi` (Scalar UI).
  // AOT mode: serves the compiler-generated `dist/openapi.json` artifact.
  openapi({ artifactPath: "dist/openapi.json" }),
];

const i18n = createI18n(
  {
    en: { greeting: "Hello {name}", visits: "You have visited {count} times" },
    es: { greeting: "Hola {name}", visits: "Has visitado {count} veces" },
    fr: { greeting: "Bonjour {name}", visits: "Vous avez visité {count} fois" },
  },
  { fallbackLocale: "en", defaultLocale: "en" },
);

export const lifecycle = {
  request: [i18n.middleware()],
  // Global lifecycle stage hooks (see src/middleware/log-requests.ts).
  beforeHandle: [logRequests(), markResponse()],
};

// Static response headers served natively by Bun's default-header sink (applied
// to every response with zero per-request JS). Replaces the per-request JS
// `security()` plugin for the static set (HSTS stays out — HTTPS-only, belongs
// at the TLS-terminating proxy) and provides the OK-path CORS wildcard (native
// castrum CORS owns preflight; `Access-Control-Allow-Origin: *` is equivalent
// to the origin echo for non-credentialed requests).
export const server = {
  port: env.PORT,
  // HTTPS by default (TLS). In dev, ignex auto-generates a local certificate
  // (mkcert → openssl) cached under `dist/certs`; set `tls: { certFile,
  // keyFile }` to use your own certs, or `https: false` for plain HTTP/1.
  https: true,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' https: 'unsafe-inline'",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-XSS-Protection": "0",
  },
};
