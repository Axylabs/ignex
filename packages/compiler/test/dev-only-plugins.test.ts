/**
 * Dev-only plugin elimination tests.
 *
 * `debugbar()` must never degrade — or ship inside — a production build: when
 * the build is production-shaped, EVERY reachable debugbar is eliminated
 * (explicit `IGNEX_DEBUG=1` at build time opts back in). When it is provably
 * disabled (`enabled: false`, or default mode in production), routes keep
 * constant-response hoisting and usage-specialized contexts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/frontend";
import { buildAsync } from "../src/index";
import { isProductionBuild, resolveAppConfig } from "../src/phases/analysis/app-config";
import {
  analyzeDevOnlyPlugins,
  analyzePluginCalls,
  debugbarStubRewrite,
} from "../src/phases/analysis/dev-only-plugins";
import { resolveGlobalPluginUsage } from "../src/phases/analysis/internal-plugins";
import { parseToAst } from "../src/utils/ast/parse/bridge";
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

  it("keeps debugbar({ enabled: true }) in a dev-shaped build", () => {
    const r = analyze(configSource("debugbar", "debugbar({ enabled: true })"), false);
    expect(r).toEqual({ eliminated: 0, kept: 1, totalElements: 1 });
  });

  it("eliminates debugbar({ enabled: true }) in a production build (IGNEX_DEBUG=1 is the only opt-in)", () => {
    const r = analyze(configSource("debugbar", "debugbar({ enabled: true })"), true);
    expect(r).toEqual({ eliminated: 1, kept: 0, totalElements: 1 });
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

  it("eliminates a non-literal enabled expression in a production build (env decides at runtime, build decides inclusion)", () => {
    const r = analyze(
      configSource("debugbar", "debugbar({ enabled: process.env.X === '1' })"),
      true,
    );
    expect(r).toEqual({ eliminated: 1, kept: 0, totalElements: 1 });
  });

  it("only eliminates the debugbar elements when mixed with real plugins", () => {
    const r = analyze(configSource("compression, debugbar", "compression(), debugbar()"), true);
    expect(r).toEqual({ eliminated: 1, kept: 0, totalElements: 2 });
  });

  it("does nothing without a debugbar import", () => {
    const r = analyze(configSource("compression", "compression()"), true);
    // Non-empty array without a debugbar import: UNKNOWN shape → conservative
    // `totalElements: 1` so callers keep the export active.
    expect(r).toEqual({ eliminated: 0, kept: 0, totalElements: 1 });
  });

  it("treats a statically empty plugins array as hook-free", () => {
    const r = analyze(`export const plugins = [];\n`, true);
    expect(r).toEqual({ eliminated: 0, kept: 0, totalElements: 0 });
    // …even when debugbar is imported but never registered.
    const r2 = analyze(
      `import { debugbar } from "@ignex/core";\nexport const plugins = [];\n`,
      false,
    );
    expect(r2).toEqual({ eliminated: 0, kept: 0, totalElements: 0 });
  });

  it("is conservative for unknown plugin shapes (no static array)", () => {
    const src = `import p from "./p";\nexport const plugins = p;\n`;
    const r = analyze(src, true);
    expect(r).toEqual({ eliminated: 0, kept: 0, totalElements: 1 });
  });

  it("is conservative for aliased imports (no elimination)", () => {
    const src = `import { debugbar as db } from "@ignex/core";\nexport const plugins = [db()];\n`;
    const r = analyze(src, true);
    expect(r).toEqual({ eliminated: 0, kept: 0, totalElements: 1 });
  });

  it("folds spread-hidden debugbar out of production builds (__TRACE_DEBUG signal)", () => {
    const src = `import { debugbar } from "@ignex/core";\nexport const plugins = [...(env.DEBUG ? [debugbar({ enabled: true })] : [])];\n`;
    const sm = new SourceManager();
    const file = sm.fromSource("/tmp/app.config.ts", "./src/app.config.ts", src);
    // Dev build: kept — the debugbar could be enabled at runtime.
    const dev = analyzeDevOnlyPlugins(file, false);
    expect(dev.kept).toBe(1);
    // Production build: eliminated everywhere — a stray DEBUG=true env file
    // must not compile the toolbar into the artifact. IGNEX_DEBUG=1 at build
    // time is the explicit opt-back-in (it flips the production decision).
    const prod = analyzeDevOnlyPlugins(file, true);
    expect(prod.kept).toBe(0);
    expect(prod.eliminated).toBe(0); // top-level elimination stays conservative for spreads
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

    // The explicit `production` option (set by `ignex build` by default)
    // implies the production shape without NODE_ENV or a binary compile.
    expect(isProductionBuild({ production: true } as never)).toBe(true);
    expect(isProductionBuild({ production: false } as never)).toBe(false);

    process.env.NODE_ENV = "production";
    expect(isProductionBuild({} as never)).toBe(true);
    process.env.IGNEX_DEBUG = "1";
    expect(isProductionBuild({} as never)).toBe(false);
    expect(isProductionBuild({ compile: true } as never)).toBe(false);
    expect(isProductionBuild({ production: true } as never)).toBe(false);
  });
});

describe("debugbarStubRewrite (production artifact slimming)", () => {
  it("rebinds the import to an inert local stub, keeping sibling specifiers", () => {
    const src =
      `import { compression, debugbar, openapi } from "@ignex/core";\n` +
      `export const plugins = [compression(), debugbar(), openapi()];\n`;
    const out = debugbarStubRewrite(src);
    expect(out).not.toBeNull();
    expect(out).toContain('const debugbar = () => ({ name: "debugbar", __ignexDevOnly: true });');
    expect(out).toMatch(/import \{ compression,\s*openapi \} from "@ignex\/core";/);
  });

  it("handles aliased bindings and both comma positions", () => {
    const src =
      `import { debugbar as db } from "@ignex/core";\n` +
      `import { debugbar } from "@ignex/core/index";\n` +
      `export const plugins = [debugbar(), db()];\n`;
    const out = debugbarStubRewrite(src);
    expect(out).not.toBeNull();
    expect(out).toContain("const db = ");
    expect(out).toContain("const debugbar = ");
    // The rewritten module must stay syntactically valid.
    expect(() => parseToAst(out as string)).not.toThrow();
  });

  it("returns null without a static named debugbar import", () => {
    expect(debugbarStubRewrite(`export const plugins = [];\n`)).toBeNull();
    expect(
      debugbarStubRewrite(
        `import * as core from "@ignex/core";\nexport const p = [core.debugbar()];\n`,
      ),
    ).toBeNull();
  });
});

describe("analyzePluginCalls", () => {
  const analyze = (src: string) => {
    const sm = new SourceManager();
    const sf = sm.fromSource("/app/src/app.config.ts", "src/app.config.ts", src, {
      warn() {},
    } as never);
    return analyzePluginCalls(sf);
  };

  it("attributes internal plugin calls to @ignex/core", () => {
    const r = analyze(
      `import { cors, security } from "@ignex/core";\n` +
        `export const plugins = [cors({ origin: ["https://a"] }), security({ hsts: false })];\n`,
    );
    expect(r.allResolved).toBe(true);
    expect(r.calls).toEqual([
      { name: "cors", source: "@ignex/core" },
      { name: "security", source: "@ignex/core" },
    ]);
  });

  it("resolves a statically empty array to no plugins", () => {
    const r = analyze(`export const plugins = [];\n`);
    expect(r.allResolved).toBe(true);
    expect(r.calls).toEqual([]);
  });

  it("clears allResolved for anything it cannot attribute", () => {
    // Spread element.
    expect(
      analyze(
        `import { cors } from "@ignex/core";\nimport { extra } from "./extra";\nexport const plugins = [cors(), ...extra()];\n`,
      ).allResolved,
    ).toBe(false);
    // A callee that was never imported.
    expect(
      analyze(`import { cors } from "@ignex/core";\nexport const plugins = [cors(), mystery()];\n`)
        .allResolved,
    ).toBe(false);
    // No `plugins` export at all.
    expect(analyze(`export const server = {};\n`).allResolved).toBe(false);
    // A non-static initializer (identifier, not an array literal).
    expect(
      analyze(
        `import { cors } from "@ignex/core";\nconst list = [cors()];\nexport const plugins = list;\n`,
      ).allResolved,
    ).toBe(false);
  });

  it("reports an aliased import under its ALIAS, so a name-keyed registry misses it", () => {
    // `source.imports` carries local binding names, so `cors as c` resolves to
    // name "c". A registry keyed on `cors` will not match, which is the
    // conservative outcome; the analyzer must not claim it is `cors`.
    const r = analyze(`import { cors as c } from "@ignex/core";\nexport const plugins = [c()];\n`);
    expect(r.allResolved).toBe(true);
    expect(r.calls).toEqual([{ name: "c", source: "@ignex/core" }]);
  });

  it("reports a foreign export aliased to a known name with its REAL source", () => {
    // A consumer must require the SOURCE too: this reports name "cors" from a
    // user module, and must never be mistaken for @ignex/core's cors.
    const r = analyze(`import { mine as cors } from "./mine";\nexport const plugins = [cors()];\n`);
    expect(r.allResolved).toBe(true);
    expect(r.calls).toEqual([{ name: "cors", source: "./mine" }]);
  });
});

describe("resolveGlobalPluginUsage", () => {
  const CORE = "@ignex/core";

  it("merges the audited declaration of an internal plugin", () => {
    const { usage } = resolveGlobalPluginUsage([{ name: "security", source: CORE }], true);
    expect(usage).not.toBeNull();
    expect(usage?.headers).toBe(true);
    expect(usage?.req).toBe(true);
    // Everything not declared must stay false, or the declaration is a lie.
    expect(usage?.cookie).toBe(false);
    expect(usage?.proxy).toBe(false);
    expect(usage?.body).toBe(false);
  });

  it("declares cors, now that ctx.method is expressible", () => {
    // cors reads ctx.headers and ctx.method (OPTIONS preflight). It was
    // undeclarable while `method` collapsed onto the `url` flag.
    const { usage } = resolveGlobalPluginUsage([{ name: "cors", source: CORE }], true);
    expect(usage).not.toBeNull();
    expect(usage?.headers).toBe(true);
    expect(usage?.method).toBe(true);
    // Members cors does NOT read must stay false.
    expect(usage?.cookie).toBe(false);
    expect(usage?.set).toBe(false);
    expect(usage?.body).toBe(false);
  });

  it("returns null for a user plugin, an unknown internal name, or an unresolved list", () => {
    expect(resolveGlobalPluginUsage([{ name: "mine", source: "./mine" }], true).usage).toBeNull();
    expect(resolveGlobalPluginUsage([{ name: "nosuch", source: CORE }], true).usage).toBeNull();
    expect(resolveGlobalPluginUsage([{ name: "security", source: CORE }], false).usage).toBeNull();
  });

  it("resolves the same plugin through the alternate publish path", () => {
    const { usage } = resolveGlobalPluginUsage(
      [{ name: "security", source: "@ignex/core/index" }],
      true,
    );
    expect(usage?.headers).toBe(true);
  });

  it("yields an all-false requirement for an empty plugin list", () => {
    const { usage } = resolveGlobalPluginUsage([], true);
    expect(usage).not.toBeNull();
    expect(Object.values(usage as unknown as Record<string, boolean>).some(Boolean)).toBe(false);
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

  it("folds the plugin trust-proxy declaration into the context options", async () => {
    const layout = materializeFixture("debugbar");
    delete process.env.NODE_ENV;
    const result = await build(layout, fixturePath("debugbar", "app.config.ts"));
    expect(result.errors).toHaveLength(0);

    // `trustProxy` reached NOTHING before this: `ctx.ip` reads
    // `ContextOptions.trustProxy`, the compiler never set it, and the option
    // was silently inert in every AOT app while interpreted apps honoured it
    // through `createApp`. The constant is folded at boot from the same
    // `IgnexPlugin.contextOptions` declaration `collectContextOptions` merges.
    expect(result.code).toContain("const __TRUST_PROXY");
    expect(result.code).toContain("__appConfig.plugins");
    expect(result.code).toContain("contextOptions");
    // Both context-options literals carry it, so route contexts AND the
    // non-route ones (OPTIONS/404/405/error) resolve the client identically.
    expect(result.code).toContain("trustProxy: __TRUST_PROXY");
  });

  it("const-folds trustProxy to false when the app has no config", async () => {
    // No plugins can declare it, so the boot loop is not emitted at all and the
    // guard const-folds — an app without an app config pays nothing for this.
    const layout = materializeFixture("basic");
    const result = await buildAsync({
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
    });
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("const __TRUST_PROXY = false");
  });

  it("the `production: true` option shapes the artifact with NODE_ENV unset", async () => {
    // `ignex build` sets `production: true` by default — the deploy artifact
    // must be production-shaped even when the CI/dev shell has no NODE_ENV.
    const layout = materializeFixture("debugbar");
    delete process.env.NODE_ENV;
    const result = await buildAsync({
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
      appConfig: fixturePath("debugbar", "app.config.ts"),
      production: true,
    });
    expect(result.errors).toHaveLength(0);
    // Debugbar eliminated → tracing instrumentation folded out + AOT restored.
    expect(result.code).toContain("const __TRACE_DEBUG = false");
    expect(result.code).not.toContain("__ctxOpts_");
    // The runtime guard is baked so a launch without NODE_ENV stays locked.
    expect(result.code).toContain("globalThis.__IGNEX_PROD_BUILD = true");
    // Safe error responses by default under a production shape.
    expect(result.code).toContain("const EXPOSE_ERRORS = false");
    // The TLS policy never auto-generates dev certs in a prod-shaped artifact.
    expect(result.code).toContain("production: true,\n  certDir:");
    // The import-binding stub treeshakes the debug graph out of the bundle:
    // no dashboard SPA (tailwind CSS string), no observatory endpoints — and
    // none of the debugger's event tooling (the unified event buffer + the
    // manual realtime "emit" endpoint) ships inside the production artifact.
    expect(result.code).not.toContain("tailwindcss");
    expect(result.code).not.toContain("createEndpointTable");
    expect(result.code).not.toContain("nova/events/emit");
    expect(result.code).not.toContain("Nova realtime (WS)");
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
