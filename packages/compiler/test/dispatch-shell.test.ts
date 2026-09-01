/**
 * Dispatch-shell specialization tests.
 *
 * Pass 1 records the statically-proven wrapper variant per route; pass 2
 * binds it in Bun's route table:
 *   - constant-hoisted GETs → `__wrapStaticSync` + a build-time HEAD handler
 *   - async static routes   → `__wrapStatic` (no wildcard block / URL parse)
 *   - sync compact routes   → `__wrapStaticSync`
 *   - wildcard routes       → generic runtime-checked `__wrap` (unchanged)
 *
 * Also covers the dev-only heat capture emission (`heatCapture`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { heatContribution, loadRouteHeat } from "../src/phases/analysis/heat";
import { type FixtureLayout, fixturePath, materializeFixture } from "./helpers";

const baseOptions = (layout: FixtureLayout, extra: Record<string, unknown> = {}) => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: false,
  generateOpenAPI: false,
  generateClient: false,
  precompileValidators: false,
  precompileSerializers: false,
  ...extra,
});

describe("dispatch shell specialization", () => {
  it("binds the pre-built static Response for constant GET routes", async () => {
    const layout = materializeFixture("dispatch");
    const result = await buildAsync(baseOptions(layout));

    // Constant `/` route is bound as a pre-built Response VALUE — Bun serves
    // it natively in Rust (zero per-request JS, native auto-HEAD).
    expect(result.code).toMatch(/GET: STATIC_RES_\w+/);
    // Body is the JSON TEXT as a JS string literal (wire parity with
    // `jsonReply`'s JSON.stringify), not the re-parsed value.
    expect(result.code).toMatch(/const STATIC_RES_\w+ = new Response\(".*", INIT_\w+\);/);
    // No explicit HEAD entry: table-bound Response values get native auto-HEAD.
    const rootBlock = result.code.match(/"\/":\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rootBlock).toMatch(/GET: STATIC_RES_\w+/);
    expect(rootBlock).not.toMatch(/HEAD:/);
    // The generic wildcard-checked wrapper is still referenced by the
    // wildcard fixture route.
    expect(result.code).toMatch(/__wrap\(GET_\w+, \["path"\], "\/files\/"\)/);
  });

  it("binds the static async wrapper for param routes", async () => {
    const layout = materializeFixture("dispatch");
    const result = await buildAsync(baseOptions(layout));

    // `users/[id].get.ts` is dynamic (`:id`) but NOT a wildcard — no
    // `new URL` fallback block, promise funnel retained.
    expect(result.code).toMatch(/GET: __wrapStatic\(GET_\w+\)/);
    expect(result.code).toMatch(/"\/users\/:id"/);
  });

  it("keeps the generic __wrap for wildcard routes and WS routes", async () => {
    const layout = materializeFixture("dispatch");
    const result = await buildAsync(baseOptions(layout));

    expect(result.code).toMatch(/__wrap\((?:GET|WS)_\w+(?:, \["path"\], "\/files\/")?\)/);
  });

  it("emits the HEAD strip helpers exactly once each", async () => {
    const layout = materializeFixture("dispatch");
    const result = await buildAsync(baseOptions(layout));

    expect(result.code.match(/function __stripForHead\(/g)).toHaveLength(1);
    expect(result.code.match(/function __headStatic\(/g)).toHaveLength(1);
  });
});

describe("dev heat capture (heatCapture)", () => {
  it("emits the counter module + per-route increments when enabled", async () => {
    const layout = materializeFixture("dispatch");
    const result = await buildAsync(baseOptions(layout, { heatCapture: true }));

    expect(result.code).toContain("hot-routes.json");
    expect(result.code).toContain("__heatFlush");
    expect(result.code).toContain('__heat["GET /"]');
  });

  it("emits nothing when heatCapture is off (default)", async () => {
    const layout = materializeFixture("dispatch");
    const result = await buildAsync(baseOptions(layout));

    expect(result.code).not.toContain("__heat[");
    expect(result.code).not.toContain("hot-routes.json");
  });
});

describe("route heat analysis (hot-routes.json)", () => {
  it("contributes log-scaled heat to hotnessScore via the manifest", async () => {
    const layout = materializeFixture("dispatch");

    // Baseline build without heat data.
    await buildAsync(baseOptions(layout));
    const manifestPath = join(layout.outDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const base = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      routes: Array<{ method: string; path: string; hotnessScore: number }>;
    };
    const baseRoot = base.routes.find((r) => r.path === "/");
    if (!baseRoot) throw new Error("fixture route '/' missing from manifest");

    // Same inputs + a heat file counting "/" heavily.
    writeFileSync(
      join(layout.outDir, "hot-routes.json"),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        routes: { "GET /": 4096 },
      }),
    );
    await buildAsync(baseOptions(layout));
    const heated = JSON.parse(readFileSync(manifestPath, "utf-8")) as typeof base;
    const heatedRoot = heated.routes.find((r) => r.path === "/");
    if (!heatedRoot) throw new Error("fixture route '/' missing from heated manifest");

    expect(heatedRoot.hotnessScore).toBeGreaterThan(baseRoot.hotnessScore);
    expect(heatedRoot.hotnessScore - baseRoot.hotnessScore).toBe(heatContribution(4096));
  });

  it("ignores missing/malformed heat files and invalid entries", () => {
    expect(loadRouteHeat({ outDir: "/nonexistent-ignex-out" }).size).toBe(0);

    const layout = materializeFixture("dispatch");
    writeFileSync(join(layout.outDir, "hot-routes.json"), "{not json");
    expect(loadRouteHeat({ outDir: layout.outDir }).size).toBe(0);

    writeFileSync(
      join(layout.outDir, "hot-routes.json"),
      JSON.stringify({
        version: 99,
        routes: { "GET /": 5, BAD: -3, "GET /x": "many", "GET /y": Number.NaN },
      }),
    );
    expect(loadRouteHeat({ outDir: layout.outDir }).size).toBe(0);

    writeFileSync(
      join(layout.outDir, "hot-routes.json"),
      JSON.stringify({ version: 1, routes: { "GET /": 7, "GET /bad": -1, "GET /str": "x" } }),
    );
    const heat = loadRouteHeat({ outDir: layout.outDir });
    expect(heat.get("GET /")).toBe(7);
    expect(heat.size).toBe(1);
  });

  it("scales heat contribution logarithmically with a cap", () => {
    expect(heatContribution(undefined)).toBe(0);
    expect(heatContribution(0)).toBe(0);
    expect(heatContribution(-5)).toBe(0);
    expect(heatContribution(Number.NaN)).toBe(0);
    expect(heatContribution(1)).toBe(1);
    expect(heatContribution(15)).toBe(4); // log2(16) = 4
    expect(heatContribution(1023)).toBe(10);
    expect(heatContribution(1_000_000)).toBe(10); // capped
  });
});

describe("fixture sanity", () => {
  it("has the dispatch fixture on disk", () => {
    expect(existsSync(fixturePath("dispatch", "index.get.ts"))).toBe(true);
  });
});
