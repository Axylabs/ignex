/**
 * Tests for the scaffold env-config templates: `src/config/env.ts` source,
 * the `.env.example` derived from `SCAFFOLD_ENV_SCHEMA`, and the refactored
 * `app.config.ts` / `env.get.ts` templates that consume the env module
 * (no raw `process.env` reads).
 */
import { expect, test } from "vitest";
import {
  envConfigTemplate,
  envExampleTemplate,
  SCAFFOLD_ENV_SCHEMA,
} from "../src/templates/env.js";
import { appConfigTemplate, envRouteTemplate } from "../src/templates/routes.js";

/** Extract the property keys declared in the `Type.Object({...})` source. */
function schemaKeysFromSource(source: string): string[] {
  const body = source.slice(source.indexOf("Type.Object"), source.indexOf("});"));
  return [...body.matchAll(/^\s{2}([A-Z0-9_]+):/gm)].map((m) => m[1]);
}

test("envConfigTemplate emits a TypeBox schema + defineEnv via @ignex/core/env", () => {
  const code = envConfigTemplate();
  expect(code).toContain('import { Type, defineEnv } from "@ignex/core/env";');
  expect(code).toContain("export const envSchema = Type.Object({");
  expect(code).toContain("export const env = defineEnv(envSchema);");
});

test("the emitted schema source matches the SCAFFOLD_ENV_SCHEMA keys (drift guard)", () => {
  const sourceKeys = schemaKeysFromSource(envConfigTemplate());
  const objectKeys = Object.keys(SCAFFOLD_ENV_SCHEMA.properties);
  expect(sourceKeys.sort()).toEqual(objectKeys.sort());
});

test("envExampleTemplate derives .env.example from the schema with defaults and blank secrets", () => {
  const example = envExampleTemplate();
  expect(example).toContain("# OPTIONAL · secret — SESSION_SECRET");
  expect(example).toContain("SESSION_SECRET=");
  expect(example).toContain("# OPTIONAL — PORT (default: 3000)");
  expect(example).toContain("PORT=3000");
  expect(example).toContain("# OPTIONAL — NODE_ENV (default: development)");
});

test("appConfigTemplate consumes the env module instead of raw process.env", () => {
  const code = appConfigTemplate();
  expect(code).toContain('import { env } from "./config/env.js";');
  // Scaffold secret: explicit SESSION_SECRET wins; local dev falls back to a
  // strong per-machine generated value — never a known literal default.
  expect(code).toContain("session({ secret: env.SESSION_SECRET || devSessionSecret()");
  expect(code).toContain(
    'import {\n  debugbar,\n  devSessionSecret,\n  openapi,\n  session,\n  type ServerConfig,\n} from "@ignex/core";',
  );
  // The `server` export is typed with the public ServerConfig interface.
  expect(code).toContain("export const server: ServerConfig = {");
  expect(code).not.toContain("dev-secret-change-me");
  expect(code).toContain("port: env.PORT,");
  expect(code).not.toContain("process.env");
});

test("appConfigTemplate defaults to HTTPS and emits plain HTTP when https: false", () => {
  expect(appConfigTemplate()).toContain("https: true");
  // HTTP/2 is opt-in — off by default.
  expect(appConfigTemplate()).not.toMatch(/^ {2}h2: true,/m);

  const http = appConfigTemplate({ https: false });
  expect(http).toContain("https: false");
  // The resolved `ServerConfig` type stays regardless of the transport choice.
  expect(http).toContain("export const server: ServerConfig = {");
  expect(http).not.toMatch(/^ {2}h2: true,/m);
});

test("appConfigTemplate opts into HTTP/2 when h2 is enabled over HTTPS", () => {
  const h2 = appConfigTemplate({ https: true, h2: true });
  expect(h2).toMatch(/^ {2}https: true,/m);
  expect(h2).toMatch(/^ {2}h2: true,/m);

  // h2 only makes sense over TLS — an HTTP-only scaffold never emits it.
  const http = appConfigTemplate({ https: false, h2: true });
  expect(http).toContain("https: false");
  expect(http).not.toMatch(/^ {2}h2: true,/m);
});

test("envRouteTemplate reads validated env values via the env module", () => {
  const code = envRouteTemplate();
  expect(code).toContain('import { env } from "../config/env.js";');
  expect(code).toContain("env.NODE_ENV");
  expect(code).toContain("env.PORT");
  expect(code).not.toContain("process.env");
});
