/**
 * Flux application configuration.
 *
 * The compiler reads this file at build time and merges `plugins`, `lifecycle`
 * and `server` into the generated `Bun.serve` entry.
 */
import { compression, cors, createI18n, type FluxPlugin, security, session } from "@flux/core";

const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-secret-change-me";

export const plugins: FluxPlugin[] = [
  cors(),
  compression(),
  security(),
  session({ secret: SESSION_SECRET, createIfMissing: true }),
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
