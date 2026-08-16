/**
 * Codegen tests for the opt-in per-route native prelude (`nativeRoutes`).
 *
 * With `nativeRoutes: true`, eligible full-context routes (schema export +
 * query/cookie parse) emit a pre-baked `createNativeRoute` plan — the exact
 * pipeline the addon compiles — plus a native-first parse with a JS fallback.
 * With the option off (default) the emitted output is unchanged (zero
 * regression), and ineligible routes (body-only) keep the plain JS prelude.
 */
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { type FixtureLayout, materializeFixture } from "./helpers";

const baseOptions = (layout: FixtureLayout, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

describe("per-route native prelude (nativeRoutes)", () => {
  it("emits a createNativeRoute plan + native query prelude when enabled", async () => {
    // named-export/schema.get.ts exports a query schema → eligible.
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout, { nativeRoutes: true }));

    expect(result.code).toContain("createNativeRoute");
    expect(result.code).toContain("__nativeRoute_");
    expect(result.code).toContain('"parseQuery"'); // exact pipeline stage
    // native-first parse seeds ctx.query via the pair→record helper, with a
    // JS `parseQueryFromURL` fallback (parity when the addon lacks the surface).
    expect(result.code).toContain("groupQueryPairs");
    expect(result.code).toContain("__native.run(");
    expect(result.code).toContain("parseQueryFromURL");
  });

  it("does NOT emit native code when nativeRoutes is explicitly off", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout, { nativeRoutes: false }));
    expect(result.code).not.toContain("createNativeRoute");
    expect(result.code).not.toContain("__nativeRoute_");
  });

  it("emits native code by default (Phase 4: nativeRoutes on)", async () => {
    // Phase 4 flipped the default: an eligible route builds the native stack
    // WITHOUT explicitly enabling nativeRoutes.
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));
    expect(result.code).toContain("createNativeRoute");
    expect(result.code).toContain("__nativeRoute_");
  });

  it("emits native body stages for a validate-and-ack body route (Phase 2)", async () => {
    // schema fixture: body schema, handler never reads ctx.body → the native
    // stack validates the raw bytes and JS never parses the body.
    const layout = materializeFixture("schema");
    const result = await buildAsync(baseOptions(layout, { nativeRoutes: true }));

    expect(result.code).toContain("createNativeRoute");
    expect(result.code).toContain('"requireJsonBody"'); // exact pipeline stage
    expect(result.code).toContain('"validateBody"');
    expect(result.code).toContain("new TextEncoder().encode"); // body schema bytes
    // The native verdict skips the JS body parse entirely.
    expect(result.code).toContain("__bodyValidated = true");
    expect(result.code).toContain("__native.run(");
    // 400 / 422 error mapping.
    expect(result.code).toContain("BodyParseError");
    expect(result.code).toContain("validationError");
  });

  it("keeps the plain JS body prelude when the handler READS the body", async () => {
    // body-read fixture: handler reads ctx.body → body must be parsed in JS
    // (not validate-and-ack) → not native-eligible, plain JS prelude.
    const layout = materializeFixture("body-read");
    const result = await buildAsync(baseOptions(layout, { nativeRoutes: true }));
    expect(result.code).not.toContain("createNativeRoute");
    expect(result.code).not.toContain("__nativeRoute_");
    // Body still validated via the JS path (runtime or precompiled).
    expect(result.code).toContain("validate_");
    expect(result.code).toContain("ctx.body.json");
  });
});
