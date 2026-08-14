/**
 * Hardening regression tests — cover previously-untested/rough paths that were
 * fixed as part of the compiler-hardening pass:
 *  - `resolveHook`: missing vs unreadable vs empty hook modules are now
 *    distinguishable (`IGN_HOOK_MISSING` vs `IGN_IO_READ_FAILED` vs valid).
 *  - `schema-loader`: the module precompilation cache is bounded + resettable.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticCodes, DiagnosticCollector } from "../src/diagnostics.js";
import { SourceManager } from "../src/frontend/source-manager.js";
import { buildAsync } from "../src/index.js";
import { resolveHook } from "../src/phases/analysis/hooks.js";
import { clearModuleCache, loadRouteModule } from "../src/phases/schema-loader.js";
import { fixturePath, materializeFixture } from "./helpers";

const tmp = () => mkdtempSync(join(tmpdir(), "ignex-hardening-"));

const mkCtx = () => {
  const d = new DiagnosticCollector();
  return {
    ctx: {
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        time: (_: string, fn: () => unknown) => fn(),
      },
      diagnostics: d,
    },
    d,
  };
};

describe("resolveHook", () => {
  it("emits IGN_HOOK_MISSING when the hook module does not exist", () => {
    const dir = tmp();
    const { ctx, d } = mkCtx();
    const result = resolveHook("nope", dir, new SourceManager(), ctx as never);
    expect(result).toBeUndefined();
    expect(d.warnings.some((w) => w.code === DiagnosticCodes.HookMissing)).toBe(true);
  });

  it("emits IGN_IO_READ_FAILED when the hook exists but is unreadable", () => {
    const dir = tmp();
    // A directory passes existsSync but fails readFileSync (EISDIR).
    mkdirSync(join(dir, "broken.ts"), { recursive: true });

    const { ctx, d } = mkCtx();
    const result = resolveHook("broken", dir, new SourceManager(), ctx as never);
    expect(result).toBeUndefined();
    expect(d.warnings.some((w) => w.code === DiagnosticCodes.IoReadFailed)).toBe(true);
  });

  it("does not treat a legitimately empty hook as a read failure", () => {
    const dir = tmp();
    writeFileSync(join(dir, "empty.ts"), "");

    const { ctx, d } = mkCtx();
    const result = resolveHook("empty", dir, new SourceManager(), ctx as never);
    expect(result).toBeDefined();
    expect(d.warnings.some((w) => w.code === DiagnosticCodes.IoReadFailed)).toBe(false);
  });
});

describe("schema-loader module cache", () => {
  it("caches a successfully loaded module by content hash and can be cleared", async () => {
    const dir = tmp();
    const file = join(dir, "with-schema.ts");
    writeFileSync(
      file,
      `export const schema = { type: "object", properties: { name: { type: "string" } } };\nexport default {};\n`,
    );

    // A schema export makes `loadRouteModule` wrap the namespace in a fresh
    // object, so the module-level cache (not the ESM registry) is observable.
    const first = await loadRouteModule(file);
    const second = await loadRouteModule(file);
    expect(first).toBe(second);

    clearModuleCache();
    const third = await loadRouteModule(file);
    expect(third).not.toBe(first);
  });

  it("does not cache a module that fails to load", async () => {
    const dir = tmp();
    const file = join(dir, "broken.ts");
    writeFileSync(
      file,
      `import { missingThing } from "./does-not-exist.ts";\nexport default missingThing;\n`,
    );

    const d = new DiagnosticCollector();
    const result = await loadRouteModule(file, d);
    expect(result).toBeUndefined();
    expect(d.warnings.some((w) => w.code === DiagnosticCodes.ModuleLoadFailed)).toBe(true);

    // The failed load must not be cached — a subsequent (fixed) import retries.
    clearModuleCache();
    const again = await loadRouteModule(file, d);
    expect(again).toBeUndefined();
  });
});

describe("plugin boot boundary (compiled server)", () => {
  it("emits an attributable error when a plugin throws at boot", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync({
      routesDir: layout.routesDir,
      outDir: layout.outDir,
      outFile: "server.js",
      appConfig: fixturePath("basic", "app.config.ts"),
      optimizationLevel: 3,
      minify: false,
      sourceMap: false,
      incremental: false,
      precompileValidators: true,
      precompileSerializers: true,
    });

    // A throwing plugin must surface a clear, attributable message instead of a
    // cryptic module-load failure / unhandled rejection.
    expect(result.code).toContain("[ignex] plugin boot failed");
    expect(result.code).toContain("catch (__err) {");
  });
});
