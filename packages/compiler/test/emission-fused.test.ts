/**
 * WS1 fused lifecycle dispatchers — emission tests.
 *
 * `stageHeader` emits `__fused` / `__fusedOK` / `__runPreParse` / `__runAfter`
 * in EVERY build (config-less servers get the runHooks-only fallback), so the
 * route lanes have one emission shape regardless of whether the app carries
 * plugins. The `__fusedOK` boot-time STRUCTURAL gate decides fused vs
 * runHooks at runtime; these tests pin the emitted shape, not the gate value.
 */

import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { fixturePath, materializeFixture } from "./helpers";

describe("WS1 fused lifecycle dispatchers", () => {
  it("emits the fused chain block for a fully-attributed plugin layer", async () => {
    const { routesDir, outDir } = materializeFixture("plugins-specialize");
    const result = await buildAsync({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: false,
      appConfig: fixturePath("plugins-specialize", "app.config.ts"),
    });

    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("const __fused = buildFusedChains(__appPlugins);");
    expect(result.code).toContain("const __runPreParse = __fusedOK");
    expect(result.code).toContain("const __runAfter = __fusedOK");
  });

  it("emits the __fusedOK gate with the preParse/afterHandle count checks", async () => {
    const { routesDir, outDir } = materializeFixture("plugins-specialize");
    const result = await buildAsync({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: false,
      appConfig: fixturePath("plugins-specialize", "app.config.ts"),
    });

    expect(result.code).toContain("__fused.preParse.length === __preParseStages.length");
    expect(result.code).toContain("__lc.mapResponse.length === 0");
    expect(result.code).toContain("__lc.afterHandle.length === (__fused.post.length > 0 ? 1 : 0)");
    expect(result.code).toContain("runFusedPre(__fused.preParse, ctx)");
    expect(result.code).toContain("runFusedPost(__fused.post, ctx, response)");
  });

  it("still declares __runPreParse for a user-lifecycle app (runHooks fallback)", async () => {
    const { routesDir, outDir } = materializeFixture("basic");
    const result = await buildAsync({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: false,
      appConfig: fixturePath("basic", "app.config.ts"),
    });

    expect(result.errors).toHaveLength(0);
    // Dispatchers are emitted unconditionally for hasAppConfig builds; the
    // user `lifecycle.request` hook makes __fusedOK evaluate to false at boot
    // (count mismatch) and both lanes fall back to runHooks.
    expect(result.code).toContain("const __runPreParse = __fusedOK");
    expect(result.code).toContain(": (ctx, response) => runHooks(__lc.afterHandle, ctx, response)");
  });

  it("emits runHooks-only fallback dispatchers for a config-less app", async () => {
    const { routesDir, outDir } = materializeFixture("basic");
    const result = await buildAsync({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("const __fusedOK = false;");
    expect(result.code).toContain(
      "const __runPreParse = (ctx) => runHooks(__preParseStages, ctx);",
    );
  });
});
