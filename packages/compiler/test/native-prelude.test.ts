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
import { baseOptions, fixturePath, materializeFixture } from "./helpers";

describe("per-route native prelude (nativeRoutes)", () => {
  it("emits a createNativeRoute plan + native query prelude when enabled", async () => {
    // named-export/schema.get.ts exports a query schema → eligible.
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout, { nativeRoutes: true }));

    expect(result.code).toContain("createNativeRoute");
    expect(result.code).toContain("__nativeRoute_");
    const initializers =
      result.code.match(/^const __nativeRoute_\w+ = createNativeRoute\(/gm) ?? [];
    expect(initializers).toHaveLength(1);
    const initAt = result.code.indexOf(initializers[0]);
    const runAt = result.code.indexOf("__native.runParts(");
    expect(initAt).toBeGreaterThanOrEqual(0);
    expect(runAt).toBeGreaterThan(initAt);
    expect(result.code).toContain('"parseQuery"'); // exact pipeline stage
    // native-first parse seeds ctx.query via the pair→record helper, with a
    // JS `parseQueryFromURL` fallback (parity when the addon lacks the surface).
    expect(result.code).toContain("groupQueryPairs");
    expect(result.code).toContain("__native.runParts("); // synced from castrum: positional run(query, cookie, body)
    expect(result.code).toContain("parseQueryFromURL");
  });

  it("does NOT emit native code when nativeRoutes is explicitly off", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout, { nativeRoutes: false }));
    expect(result.code).not.toContain("createNativeRoute");
    expect(result.code).not.toContain("__nativeRoute_");
  });

  it("keeps native routes opt-in by default", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));
    expect(result.code).not.toContain("createNativeRoute");
    expect(result.code).not.toContain("__nativeRoute_");
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
    expect(result.code).toContain("__native.runParts("); // synced from castrum: positional run(query, cookie, body)
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

  it("emits the usage-only native prelude (NativeQueryParams) for a schema-less query route", async () => {
    // usage-native/echo.get.ts reads `ctx.query` with NO schema — the
    // castrum-aligned usage-only path: the Rust stack parses query and seeds
    // ctx.query with the URLSearchParams-compatible facade (no URLSearchParams
    // rebuild, no record, no JS re-parse fallback). The fixture's app config
    // forces the full-context path (the prelude only runs there).
    const layout = materializeFixture("usage-native");
    const result = await buildAsync(
      baseOptions(layout, {
        nativeRoutes: true,
        appConfig: fixturePath("usage-native", "app.config.ts"),
      }),
    );

    expect(result.code).toContain("createNativeRoute");
    expect(result.code).toContain("runParts(");
    expect(result.code).toContain("new NativeQueryParams(__nr.query)");
    // The usage-only path must NOT emit the record/fallback machinery.
    expect(result.code).not.toContain("groupQueryPairs(__nr.query)");
    expect(result.code).not.toContain("parseQueryFromURL");
    expect(result.code).not.toContain("__validatePart(__schema?.query");
  });
});

describe("adaptive native execution (nativeRoutesAdaptive)", () => {
  it("emits the choose/record learned gate on a validated route", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout, { nativeRoutesAdaptive: true }));

    expect(result.code).toContain("createNativeRoute");
    // The learned gate: sample-token decision before the native run...
    expect(result.code).toContain("__choice = __native.chooseExecution(__q, __c, null);");
    expect(result.code).toContain(
      'if (typeof __choice === "boolean" ? __choice : __choice.native) {',
    );
    // ...runParts on the extracted component locals...
    expect(result.code).toContain("__native.runParts(__q, __c, null);");
    // ...and the record closing the sampled span at the END of the prelude
    // (after the JS fallback had its turn) on the monotonic Bun clock.
    expect(result.code).toMatch(
      /if \(typeof __choice === "object"\) \{ __native\.recordExecution\(__choice, Bun\.nanoseconds\(\)\); \}/,
    );
    // The JS fallback still guards parity when the policy picks JS.
    expect(result.code).toContain("parseQueryFromURL");
  });

  it("implies native emission without nativeRoutes", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout, { nativeRoutesAdaptive: true }));
    expect(result.code).toContain("__nativeRoute_");
    expect(result.code).toContain("chooseExecution");
  });

  it("keeps static output byte-shaped when adaptive is off", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout, { nativeRoutes: true }));
    expect(result.code).not.toContain("chooseExecution");
    expect(result.code).not.toContain("recordExecution");
    expect(result.code).toContain("__native.runParts(__qIdx < 0");
  });

  it("keeps the usage-only prelude static (nothing measurable on the JS side)", async () => {
    const layout = materializeFixture("usage-native");
    const result = await buildAsync(
      baseOptions(layout, {
        nativeRoutesAdaptive: true,
        appConfig: fixturePath("usage-native", "app.config.ts"),
      }),
    );
    // Still native — but the static always-native shape, no learned gate:
    // the usage-only fallback is the context's lazy getters, which would
    // record a zero-cost "JS" span and poison the model.
    expect(result.code).toContain("createNativeRoute");
    expect(result.code).not.toContain("chooseExecution");
    expect(result.code).toContain("new NativeQueryParams(__nr.query)");
  });
});
