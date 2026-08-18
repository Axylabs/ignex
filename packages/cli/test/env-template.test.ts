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
  expect(code).toContain('session({ secret: env.SESSION_SECRET ?? "dev-secret-change-me"');
  expect(code).toContain("port: env.PORT,");
  expect(code).not.toContain("process.env");
});

test("envRouteTemplate reads validated env values via the env module", () => {
  const code = envRouteTemplate();
  expect(code).toContain('import { env } from "../config/env.js";');
  expect(code).toContain("env.NODE_ENV");
  expect(code).toContain("env.PORT");
  expect(code).not.toContain("process.env");
});
