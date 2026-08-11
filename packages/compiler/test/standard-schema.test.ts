/**
 * Standard-Schema build-time codegen tests:
 *  - convertible parts (expose `toJSONSchema`) are precompiled into Ajv
 *    standalone validators and surfaced in OpenAPI;
 *  - unconvertible parts fall back to runtime with IGN_STANDARD_SCHEMA_RUNTIME.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync, DiagnosticCodes } from "../src/index";
import { type FixtureLayout, materializeFixture } from "./helpers";

const baseOptions = (layout: FixtureLayout) => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,
  precompileValidators: true,
  precompileSerializers: true,
});

describe("standard-schema build-time codegen", () => {
  it("precompiles a validator from a convertible Standard-Schema body", async () => {
    const layout = materializeFixture("standard-schema");
    const result = await buildAsync(baseOptions(layout));

    expect(result.errors).toHaveLength(0);

    // The convertible body produced a precompiled Ajv standalone validator.
    const validatorsDir = join(layout.outDir, "validators");
    expect(existsSync(validatorsDir)).toBe(true);
    const files = readdirSync(validatorsDir);
    expect(files.some((f) => f.endsWith(".body.cjs"))).toBe(true);

    // The generated server imports the precompiled validator.
    expect(result.code).toMatch(/validate_[A-Za-z0-9_]+_body/);

    // OpenAPI sees the converted JSON-schema body (properties not ~standard).
    const openapi = JSON.parse(readFileSync(join(layout.outDir, "openapi.json"), "utf-8")) as {
      paths: Record<
        string,
        Record<string, { requestBody?: { content?: Record<string, { schema?: unknown }> } }>
      >;
    };
    const post = openapi.paths["/create"]?.post;
    const bodySchema = post?.requestBody?.content?.["application/json"]?.schema as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(bodySchema?.properties).toHaveProperty("name");
  });

  it("falls back to runtime with a diagnostic when a part cannot be converted", async () => {
    const layout = materializeFixture("standard-schema");
    const result = await buildAsync(baseOptions(layout));

    expect(result.warnings.some((w) => w.code === DiagnosticCodes.StandardSchemaRuntime)).toBe(
      true,
    );
  });
});
