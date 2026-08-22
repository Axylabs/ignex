/**
 * Dev-only plugin elimination tests.
 *
 * `debugbar()` must never degrade a production build: when it is provably
 * disabled (explicit `enabled: false`, or the default mode in a production
 * build), the compiler drops it from the per-request lifecycle so routes keep
 * constant-response hoisting and usage-specialized contexts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/frontend";
import { buildAsync } from "../src/index";
import { isProductionBuild, resolveAppConfig } from "../src/phases/analysis/app-config";
import { analyzeDevOnlyPlugins } from "../src/phases/analysis/dev-only-plugins";
import { type FixtureLayout, fixturePath, materializeFixture } from "./helpers";

const origNodeEnv = process.env.NODE_ENV;
const origIgnExDebug = process.env.IGNEX_DEBUG;

afterEach(() => {
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
  if (origIgnExDebug === undefined) delete process.env.IGNEX_DEBUG;
  else process.env.IGNEX_DEBUG = origIgnExDebug;
});

const configSource = (imports: string, plugins: string) =>
  `import { ${imports} } from "@ignex/core";\nexport const plugins = [${plugins}];\nexport const server = { port: 3000, https: false };\n`;

const analyze = (content: string, isProduction: boolean) => {
  const sm = new SourceManager();
  const file = sm.fromSource("/tmp/app.config.ts", "./src/app.config.ts", content);
  return analyzeDevOnlyPlugins(file, isProduction);
};

describe("analyzeDevOnlyPlugins", () => {
  it("eliminates debugbar({ enabled: false }) in any build", () => {
    const r = analyze(configSource("debugbar", "debugbar({ enabled: false })"), false);
    expect(r).toEqual({ eliminated: 1, kept: 0, totalElements: 1 });
  });

  it("keeps debugbar({ enabled: true }) even in a production build", () => {
    const r = analyze(configSource("debugbar", "debugbar({ enabled: true })"), true);
    expect(r).toEqual({ eliminated: 0, kept: 1, totalElements: 1 });
  });

  it("eliminates the default debugbar() in a production build", () => {
    const r = analyze(configSource("debugbar", "debugbar()"), true);
    expect(r).toEqual({ eliminated: 1, kept: 0, totalElements: 1 });
  });

  it("keeps the default debugbar() in a dev build", () => {
    const r = analyze(configSource("debugbar", "debugbar()"), false);
    expect(r).toEqual({ eliminated: 0, kept: 1, totalElements: 1 });
  });

  it("eliminates the default debugbar() with options but no enabled key in prod", () => {
    const r = analyze(configSource("debugbar", "debugbar({ path: '/__dbg' })"), true);
    expect(r).toEqual({ eliminated: 1, kept: 0, totalElements: 1 });
  });

  it("keeps debugbar with a non-literal enabled expression (conservative)", () => {
    const r = analyze(
      configSource("debugbar", "debugbar({ enabled: process.env.X === '1' })"),
      true,
    );
    expect(r).toEqual({ eliminated: 0, kept: 1, totalElements: 1 });
  });

  it("only eliminates the debugbar elements when mixed with real plugins", () => {
    const r = analyze(configSource("compression, debugbar", "compression(), debugbar()"), true);
    expect(r).toEqual({ eliminated: 1, kept: 0, totalElements: 2 });
  });

  it("does nothing without a debugbar import", () => {
    const r = analyze(configSource("compression", "compression()"), true);
    expect(r).toEqual({ eliminated: 0, kept: 0, totalElements: 0 });
  });

  it("is conservative for aliased imports (no elimination)", () => {
    const src = `import { debugbar as db } from "@ignex/core";\nexport const plugins = [db()];\n`;
    const r = analyze(src, true);
    expect(r).toEqual({ eliminated: 0, kept: 0, totalElements: 0 });
  });

  it("keeps debugbar hidden inside spread conditionals (__TRACE_DEBUG signal)", () => {
    const src = `import { debugbar } from "@ignex/core";\nexport const plugins = [...(env.DEBUG ? [debugbar({ enabled: true })] : [])];\n`;
    const sm = new SourceManager();
    const file = sm.fromSource("/tmp/app.config.ts", "./src/app.config.ts", src);
    // Even in a production build an explicit enabled:true is never eliminated —
    // the spread must not hide it from the instrumentation decision.
    const dev = analyzeDevOnlyPlugins(file, false);
    expect(dev.kept).toBe(1);
    const prod = analyzeDevOnlyPlugins(file, true);
    expect(prod.kept).toBe(1);
    expect(prod.eliminated).toBe(0);
  });

  it("still folds a default debugbar() inside a spread in production builds", () => {
    const src = `import { debugbar } from "@ignex/core";\nexport const plugins = [...(env.DEBUG ? [debugbar()] : [])];\n`;
    const sm = new SourceManager();
    const file = sm.fromSource("/tmp/app.config.ts", "./src/app.config.ts", src);
    const prod = analyzeDevOnlyPlugins(file, true);
    expect(prod.kept).toBe(0);
    expect(prod.eliminated).toBe(0); // top-level elimination stays conservative
  });

  it("isProductionBuild honors compile + NODE_ENV and IGNEX_DEBUG overrides", () => {
    delete process.env.NODE_ENV;
    delete process.env.IGNEX_DEBUG;
    expect(isProductionBuild({ compile: true } as never)).toBe(true);
    expect(isProductionBuild({} as never)).toBe(false);

    process.env.NODE_ENV = "production";
    expect(isProductionBuild({} as never)).toBe(true);
    process.env.IGNEX_DEBUG = "1";
    expect(isProductionBuild({} as never)).toBe(false);
    expect(isProductionBuild({ compile: true } as never)).toBe(false);
  });
});

describe("app-config resolution", () => {
  it("reports hasActivePlugins=false when only an eliminated debugbar is registered", () => {
    const sm = new SourceManager();
    process.env.NODE_ENV = "production";
    const info = resolveAppConfig(
      { appConfig: fixturePath("debugbar", "app.config.ts") } as never,
      sm,
      { diagnostics: { warn() {} } } as never,
    );
    expect(info?.hasPlugins).toBe(true);
    expect(info?.hasActivePlugins).toBe(false);
  });
});

describe("production build keeps AOT optimizations", () => {
  const build = async (layout: FixtureLayout, appConfig: string) =>
    buildAsync({
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
      appConfig,
    });

  it("hoists the constant route in a production build (debugbar eliminated)", async () => {
    const layout = materializeFixture("debugbar");
    process.env.NODE_ENV = "production";
    const result = await build(layout, fixturePath("debugbar", "app.config.ts"));
    expect(result.errors).toHaveLength(0);
    // No full-context per-route plumbing → the constant route is hoisted.
    expect(result.code).not.toContain("__ctxOpts_");
    // The runtime dev-only filter is emitted as belt-and-suspenders.
    expect(result.code).toContain("__ignexDevOnly");
  });

  it("keeps the full-context pipeline in a dev build (debugbar kept)", async () => {
    const layout = materializeFixture("debugbar");
    delete process.env.NODE_ENV;
    const result = await build(layout, fixturePath("debugbar", "app.config.ts"));
    expect(result.errors).toHaveLength(0);
    // The debugbar could be enabled → the route needs the full context.
    expect(result.code).toContain("__ctxOpts_");
  });

  it("bakes __TRACE_DEBUG from whether a debugbar is kept for the build", async () => {
    // Hooks-only config (no debugbar): instrumentation const-folds away.
    const hooks = await build(materializeFixture("basic"), fixturePath("basic", "app.config.ts"));
    expect(hooks.code).toContain("const __TRACE_DEBUG = false");

    // debugbar fixture in a dev build: kept → stage instrumentation active.
    delete process.env.NODE_ENV;
    const dev = await build(
      materializeFixture("debugbar"),
      fixturePath("debugbar", "app.config.ts"),
    );
    expect(dev.code).toContain("const __TRACE_DEBUG = true");

    // debugbar fixture in a production build: the default debugbar() is
    // provably disabled → folded out (zero closures on the hot path).
    process.env.NODE_ENV = "production";
    const prod = await build(
      materializeFixture("debugbar"),
      fixturePath("debugbar", "app.config.ts"),
    );
    expect(prod.code).toContain("const __TRACE_DEBUG = false");
  });

  it("hoists regardless of build env when debugbar({ enabled: false })", async () => {
    const layout = materializeFixture("debugbar");
    // Rewrite the fixture's app config to an explicit `enabled: false`.
    const fs = await import("node:fs");
    const configPath = fixturePath("debugbar", "app.config.ts");
    const original = fs.readFileSync(configPath, "utf8");
    // Target the exact array text (the fixture comment also mentions
    // "debugbar()", so a bare replace would hit the comment instead).
    const rewritten = original.replace(
      "plugins = [debugbar()]",
      "plugins = [debugbar({ enabled: false })]",
    );
    fs.writeFileSync(configPath, rewritten);
    try {
      delete process.env.NODE_ENV;
      const result = await build(layout, configPath);
      expect(result.errors).toHaveLength(0);
      expect(result.code).not.toContain("__ctxOpts_");
    } finally {
      fs.writeFileSync(configPath, original);
    }
  });

  it("a production build never poisons the dev cache (debugbar kept)", async () => {
    // Regression: the incremental cache fingerprint must include the
    // elimination inputs (NODE_ENV / IGNEX_DEBUG), otherwise a prod-shaped
    // build caches the ELIMINATED routes and every later dev build reuses
    // them — the debugbar is compiled out even when enabled at runtime.
    const layout = materializeFixture("debugbar-direct");
    const appConfig = fixturePath("debugbar-direct", "app.config.ts");
    const buildCached = () =>
      buildAsync({
        routesDir: layout.routesDir,
        outDir: layout.outDir,
        outFile: "server.js",
        minify: false,
        sourceMap: false,
        incremental: true,
        generateTypes: false,
        generateOpenAPI: false,
        generateClient: false,
        precompileValidators: false,
        precompileSerializers: false,
        appConfig,
      });

    // Shared temp outDir → the second build hits the cache written by the first.
    process.env.NODE_ENV = "production";
    const prod = await buildCached();
    expect(prod.errors).toHaveLength(0);
    expect(prod.code).not.toContain("__ctxOpts_"); // eliminated + hoisted

    delete process.env.NODE_ENV;
    const dev = await buildCached(); // same cache dir, dev env
    expect(dev.errors).toHaveLength(0);
    // The dev build must NOT reuse the eliminated prod shape: the debugbar
    // could be enabled in dev, so the route needs the full-context pipeline.
    expect(dev.code).toContain("__ctxOpts_");
  });
});
