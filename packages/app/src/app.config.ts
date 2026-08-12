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
  // handler runs (and can enforce CORS/rate-limit/JSON-schema via `options`).
  // `readBody` stays false so the framework owns the request body. A safe
  // no-op when the Rust addon is absent (or with IGNUS_NATIVE=off).
  nativePreflight(),
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
