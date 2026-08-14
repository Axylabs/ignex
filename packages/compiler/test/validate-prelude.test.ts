/**
 * @fileoverview Usage-driven validation prelude (compiler codegen).
 *
 * The full-context validation prelude (`routes/validate.ts
 * emitFullValidationPrelude`) must parse/validate ONLY the parts a route
 * actually validates or uses. A body-only schema route must NOT parse the
 * query string, materialize request headers, or split the Cookie header on
 * every request — previously all three ran unconditionally whenever a route
 * had any validator.
 */

import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
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

describe("usage-driven validation prelude", () => {
  it("emits no query/header/cookie parsing for a body-only schema route", async () => {
    const layout = materializeFixture("schema"); // index.post.ts: body schema only
    const result = await buildAsync(baseOptions(layout));

    // The body schema IS precompiled and validated.
    expect(result.code).toContain("validate_");
    expect(result.code).toContain('"body"');

    // And NO unrelated part is parsed on the hot path.
    expect(result.code).not.toContain("parseQueryFromURL");
    expect(result.code).not.toContain("Object.fromEntries");
    expect(result.code).not.toContain("parseCookieString");
    expect(result.code).not.toContain('Object.defineProperty(ctx, "query"');
  });

  it("still emits runtime __validatePart when a schema part has no validator", async () => {
    const layout = materializeFixture("schema");
    const result = await buildAsync({
      ...baseOptions(layout),
      precompileValidators: false,
    });

    // With precompilation off, the body part falls back to runtime validation.
    expect(result.code).toContain("__validatePart");
    expect(result.code).toContain("__schemaFor");
  });
});
