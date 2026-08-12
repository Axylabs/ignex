/**
 * Ignus application configuration.
 *
 * The compiler reads this file at build time and merges `plugins`, `lifecycle`
 * and `server` into the generated `Bun.serve` entry.
 */
import {
  compression,
  cors,
  createI18n,
  type IgnusPlugin,
  nativePreflight,
  security,
  session,
} from "@ignus/core";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-secret-change-me";

export const plugins: IgnusPlugin[] = [
  cors(),
  compression(),
  security(),
  session({ secret: SESSION_SECRET, createIfMissing: true }),
  // Native pre-flight pipeline (castrum Rust ingress): one FFI call per
  // request enforces the default URL/header/query limits before the app
  // handler runs. The `runtime.securityHeaders` list pre-bakes the app's
  // security headers into the Rust pipeline at boot (`init()`), so
  // terminal/error responses (413, 400/422, 429, CORS-forbidden) carry the
  // same security posture as the OK path WITHOUT a JS lifecycle round-trip.
  // CORS preflight (OPTIONS) stays with the JS `cors()` plugin because it
  // echoes the per-request origin. `readBody` stays false so the framework
  // owns the request body. A safe no-op when the Rust addon is absent (or
  // with IGNUS_NATIVE=off).
  nativePreflight({
    runtime: {
      // Baked into castrum's terminal/error header templates (frameOptions,
      // nosniff, referrerPolicy). HSTS is deliberately excluded: the JS
      // security() plugin only ever sends it over HTTPS, and terminal
      // responses are never HTTPS-terminated here.
      securityHeaders: [
        ["x-frame-options", "DENY"],
        ["x-content-type-options", "nosniff"],
        ["referrer-policy", "no-referrer"],
      ],
    },
  }),
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
};

export const server = {
  port: Number(process.env.PORT ?? 3000),
};
