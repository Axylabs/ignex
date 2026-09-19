/**
 * @fileoverview Static-default header passthrough codegen.
 *
 * On Bun 1.4.2 `Bun.serve({ headers })` is a dead sink, so an app's declared
 * static headers (`server.headers` + plugin `responseDefaults`) reach the wire
 * only because the compiler bakes them into `__DEFAULT_HEADERS`. `__withBody`
 * applies them at response CONSTRUCTION, but raw `Response` passthroughs, the
 * 404/405 fallback, the OPTIONS preflight, errors and pre-handler short-circuits
 * bypass it. `__decorateWithDefaults` closes that gap. These tests pin that the
 * decorator is emitted and wired into every one of those paths, and that the
 * hot `__withBody` path still uses the memoized base.
 */
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { fixturePath, materializeFixture } from "./helpers";

const build = async () => {
  const { routesDir, outDir } = materializeFixture("basic");
  return buildAsync({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: false,
    generateTypes: false,
    generateOpenAPI: false,
    generateClient: false,
    appConfig: fixturePath("basic", "defaults.config.ts"),
  });
};

describe("static default header passthrough codegen", () => {
  it("folds the app's server.headers into __DEFAULT_HEADERS", async () => {
    const result = await build();
    expect(result.errors).toHaveLength(0);
    // The header VALUES are read from the app-config module at boot
    // (`__serverCfg.headers`); only the record is baked, so pin the fold.
    expect(result.code).toContain("const __serverCfg = __appConfig.server ?? {};");
    expect(result.code).toContain("if (!__pluginDefaults && !__serverCfg.headers) return null;");
    expect(result.code).toContain("const __DEFAULT_HEADERS = (() => {");
  });

  it("emits __decorateWithDefaults and wires it into every non-__withBody path", async () => {
    const result = await build();
    const code = result.code;
    expect(code).toContain("const __decorateWithDefaults = (response) =>");
    expect(code).toContain("isDecoratedResponse");
    // Raw handler Response passthrough.
    expect(code).toContain("return __DEFAULT_HEADERS ? __decorateWithDefaults(result) : result;");
    // 404/405 fallback (both the no-lifecycle end and the short-circuit branch).
    expect(code).toContain(
      "return __DEFAULT_HEADERS ? __decorateWithDefaults(response) : response;",
    );
    expect(code).toContain("? __decorateWithDefaults(__shortCircuit) : __shortCircuit;");
    // OPTIONS preflight (short-circuits before the post-handler stages).
    expect(code).toContain("return __decorateWithDefaults(new Response(response.body, {");
    // Error responses (hook + framework).
    expect(code).toContain("__decorateWithDefaults(__errorResponse)");
  });

  it("keeps the hot __withBody path on the memoized base (no per-header merge)", async () => {
    const result = await build();
    expect(result.code).toContain("__staticBaseFor(type)");
    expect(result.code).toContain("markDecoratedResponse(__response)");
  });
});
