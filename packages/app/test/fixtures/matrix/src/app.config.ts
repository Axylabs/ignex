/**
 * Matrix fixture app config — used by the request-handling integration suites.
 *
 * Enables the full plugin stack (cors / compression / security / session /
 * rate-limit) plus the i18n request middleware so the suites exercise plugin
 * behaviour end-to-end. The rate limiter is scoped to `/ratelimit` only, so
 * the other suites are never throttled.
 */
import {
  compression,
  cors,
  createI18n,
  type IgnusPlugin,
  rateLimit,
  security,
  session,
} from "@ignus/core";

export const plugins: IgnusPlugin[] = [
  cors({ origin: "*" }),
  compression(),
  security(),
  rateLimit({
    maxRequests: 5,
    windowMs: 60_000,
    skip: (ctx) => ctx.path !== "/ratelimit",
  }),
  session({
    secret: process.env.SESSION_SECRET ?? "matrix-fixture-secret",
    createIfMissing: true,
  }),
];

const i18n = createI18n(
  {
    en: { greeting: "Hello" },
    es: { greeting: "Hola" },
    fr: { greeting: "Bonjour" },
  },
  { fallbackLocale: "en", defaultLocale: "en" },
);

export const lifecycle = {
  request: [i18n.middleware()],
};

export const server = {
  port: Number(process.env.PORT ?? 3200),
};
