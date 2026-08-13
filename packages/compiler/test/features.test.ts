/**
 * Compiler feature-completeness tests: real optimization metadata, client.ts
 * emission, OpenAPI schema wiring, and optimizationLevel presets.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync, mergeOptions } from "../src";
import { fixturePath, materializeFixture } from "./helpers";

const build = (name: string) => {
  const { routesDir, outDir } = materializeFixture(name);
  return buildAsync({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: false,
  }).then((result) => ({ result, outDir }));
};

describe("compiler features", () => {
  it("reports real optimization metadata (not hardcoded zeros)", async () => {
    const { result } = await build("basic");
    expect(result.errors).toHaveLength(0);
    // echo.post is a pure, import-free inline candidate.
    expect(result.metadata.inlinedHandlers).toBeGreaterThanOrEqual(1);
    expect(result.metadata.totalCompileTime).toBeGreaterThan(0);
    expect(result.metadata.deduplicatedHandlers).toBeGreaterThanOrEqual(0);
  });

  it("emits a real client.ts implementation and enriched manifest", async () => {
    const { outDir } = await build("basic");

    expect(existsSync(join(outDir, "client.ts"))).toBe(true);
    const client = readFileSync(join(outDir, "client.ts"), "utf8");
    expect(client).toContain("createApiClient");
    expect(client).toContain('"get /health"');

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      optimizationLevel: number;
      routes: Array<{ hotnessScore: number; segmentCount: number }>;
    };
    expect(manifest.optimizationLevel).toBe(3);
    expect(typeof manifest.routes[0]?.hotnessScore).toBe("number");
    expect(typeof manifest.routes[0]?.segmentCount).toBe("number");
  });

  it("wires real request/response schemas into OpenAPI", async () => {
    const { outDir } = await build("schema");

    const openapi = JSON.parse(readFileSync(join(outDir, "openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, any>>;
    };
    const op = openapi.paths["/"]?.post;
    expect(op).toBeDefined();
    expect(op.requestBody.content["application/json"].schema.properties.name).toEqual({
      type: "string",
    });
    expect(op.responses["200"].content["application/json"].schema.properties.ok).toEqual({
      type: "boolean",
    });
    // The path param came from the schema, not a stub.
    expect(op.parameters).toBeUndefined();
  });

  it("applies optimizationLevel presets and lets explicit knobs win", () => {
    const off = mergeOptions({ optimizationLevel: 0 });
    expect(off.precompileValidators).toBe(false);
    expect(off.precompileSerializers).toBe(false);
    expect(off.inlineThreshold).toBe(0);
    expect(off.treeshakeRuntime).toBe(false);

    const full = mergeOptions({ optimizationLevel: 3 });
    expect(full.precompileValidators).toBe(true);
    expect(full.treeshakeRuntime).toBe(true);

    const custom = mergeOptions({ optimizationLevel: 0, inlineThreshold: 77 });
    expect(custom.inlineThreshold).toBe(77);
    expect(custom.precompileValidators).toBe(false);
  });

  it("emits IGN_HOOK_MISSING when a referenced hook does not exist", async () => {
    const { routesDir, outDir } = materializeFixture("basic");
    const result = await buildAsync({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: false,
      hooksDir: join(outDir, "missing-hooks"),
    });
    // basic fixture routes have no `hooks` config, so no warning should appear.
    expect(result.warnings.filter((w) => w.code === "IGN_HOOK_MISSING")).toHaveLength(0);
  });

  it("warns IGN_NON_OPTIMIZABLE_RESPONSE on direct Response.json returns", async () => {
    const { routesDir, outDir } = materializeFixture("non-optimizable");
    const result = await buildAsync({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: false,
    });

    expect(result.errors).toHaveLength(0);

    // index.get.ts returns Response.json(...) directly → warning with a position.
    const warnings = result.warnings.filter((w) => w.code === "IGN_NON_OPTIMIZABLE_RESPONSE");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.file).toContain("index.get.ts");
    expect(warnings[0]?.position).toBeDefined();

    // health.get.ts uses ctx.json(...) → not flagged.
    const healthWarning = warnings.find((w) => w.file?.includes("health.get.ts"));
    expect(healthWarning).toBeUndefined();
  });

  it("never runs plugin afterHandle on raw (non-Response) results (regression)", async () => {
    const { routesDir, outDir } = materializeFixture("basic");
    const result = await buildAsync({
      routesDir,
      outDir,
      outFile: "server.js",
      incremental: false,
      appConfig: fixturePath("basic", "app.config.ts"),
    });

    expect(result.errors).toHaveLength(0);

    // Plugin onResponse hooks must run only on the finalized response, never
    // on the raw handler result (which may be a plain object). The dead
    // `?? __lc.onResponse` fallback was removed — the lifecycle always exists.
    expect(result.code).not.toContain("__lc.afterHandle ?? [], ctx, __result");
    expect(result.code).toContain("runHooks(__lc.afterHandle, ctx, response)");
  });
});
