/**
 * Tests for the linker's `Bun.build` plugins.
 *
 * Both plugins are plain factories: they either return `null` (nothing to do)
 * or an object whose `setup(build)` registers `onResolve` / `onLoad` callbacks.
 * Driving those callbacks directly is what pins the two behaviours the linker
 * silently depends on:
 *
 *   - a generated serializer's `fast-json-stringify` import resolves to the
 *     COMPILER's install, so a scaffolded app never has to hoist it;
 *   - a production build rewrites the app-config module to flag
 *     `__IGNEX_PROD_BUILD` and stub `debugbar` away, which is what lets the
 *     bundler treeshake the whole debug graph out of the artifact.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prodShapeBunPlugin, runtimeDepPlugin } from "../src/phases/build-plugins";

/** Minimal capture surface standing in for Bun.build's `build` argument. */
interface Captured {
  name: string;
  resolveFilter?: RegExp;
  resolve?: (args: { path?: string }) => unknown;
  loadFilter?: RegExp;
  load?: (args: { path: string }) => { contents: string; loader: string } | undefined;
}

const capture = (plugin: { name: string; setup: (build: unknown) => void } | null): Captured => {
  if (!plugin) throw new Error("expected a plugin, got null");
  const out: Captured = { name: plugin.name };
  plugin.setup({
    onResolve: (opts: { filter: RegExp }, cb: (args: { path?: string }) => unknown) => {
      out.resolveFilter = opts.filter;
      out.resolve = cb;
    },
    onLoad: (opts: { filter: RegExp }, cb: (args: { path: string }) => never) => {
      out.loadFilter = opts.filter;
      out.load = cb;
    },
  });
  return out;
};

describe("runtimeDepPlugin", () => {
  const plugin = runtimeDepPlugin();

  it("registers a resolver for the compiler's own runtime deps", () => {
    if (plugin === null) {
      // `fast-json-stringify` is an optionalDependency; when it is absent the
      // plugin must degrade to "no plugin" rather than fail the build.
      expect(plugin).toBeNull();
      return;
    }
    const cap = capture(plugin);
    expect(cap.name).toBe("ignex-runtime-deps");
    expect(cap.resolveFilter).toBeInstanceOf(RegExp);
    expect(cap.resolve).toBeTypeOf("function");
  });

  it("maps the emitted specifier to an absolute path in the compiler's install", () => {
    if (plugin === null) return;
    const cap = capture(plugin);
    expect(cap.resolveFilter?.test("fast-json-stringify")).toBe(true);

    const resolved = cap.resolve?.({ path: "fast-json-stringify" });
    expect(resolved).toBeTypeOf("object");
    const path = (resolved as { path: string }).path;
    expect(path.startsWith("/")).toBe(true);
    expect(path).not.toMatch(/^file:/);
  });

  it("returns undefined for specifiers it does not own", () => {
    if (plugin === null) return;
    const cap = capture(plugin);
    // The filter excludes these, so an unrelated import is never intercepted.
    expect(cap.resolveFilter?.test("@ignex/core")).toBe(false);
    expect(cap.resolveFilter?.test("node:fs")).toBe(false);
    // And even a direct call must not invent a mapping.
    expect(cap.resolve?.({ path: "@ignex/core" })).toBeUndefined();
    expect(cap.resolve?.({})).toBeUndefined();
  });
});

describe("prodShapeBunPlugin", () => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-build-plugins-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Write an app-config module and return its absolute path. */
  const appConfig = (name: string, source: string): string => {
    const path = join(dir, name);
    writeFileSync(path, source);
    return path;
  };

  const configWithDebugbar = appConfig(
    "with-debugbar.ts",
    'import { debugbar } from "@ignex/core";\nexport const plugins = [debugbar()];\n',
  );
  const configWithout = appConfig("plain.ts", "export const plugins = [];\n");

  it("emits nothing for a dev-shaped build", () => {
    expect(prodShapeBunPlugin(configWithDebugbar, false)).toBeNull();
  });

  it("emits nothing when the app config does not exist", () => {
    expect(prodShapeBunPlugin(join(dir, "missing.ts"), true)).toBeNull();
  });

  it("flags the runtime shape from inside the app-config module", () => {
    const cap = capture(prodShapeBunPlugin(configWithDebugbar, true));
    expect(cap.name).toBe("ignex-prod-shape");

    const out = cap.load?.({ path: configWithDebugbar });
    expect(out?.loader).toBe("ts");
    // The flag must be the module's first statement: ESM hoisting evaluates
    // the plugins array (and every factory call) before entry-level code runs.
    expect(out?.contents.split("\n")[0]).toBe("globalThis.__IGNEX_PROD_BUILD = true;");
  });

  it("stubs the debugbar binding so the debug graph is treeshaken", () => {
    const cap = capture(prodShapeBunPlugin(configWithDebugbar, true));
    const contents = cap.load?.({ path: configWithDebugbar })?.contents ?? "";

    expect(contents).toContain("__ignexDevOnly: true");
    expect(contents).not.toContain("import { debugbar }");
    // The rest of the module still refers to the same local name.
    expect(contents).toContain("plugins = [debugbar()]");
  });

  it("leaves a config without a debugbar import otherwise untouched", () => {
    const cap = capture(prodShapeBunPlugin(configWithout, true));
    const contents = cap.load?.({ path: configWithout })?.contents ?? "";
    expect(contents).toBe("globalThis.__IGNEX_PROD_BUILD = true;\nexport const plugins = [];\n");
  });

  it("only loads the app-config module", () => {
    const cap = capture(prodShapeBunPlugin(configWithDebugbar, true));
    expect(cap.loadFilter?.test(configWithDebugbar)).toBe(true);
    expect(cap.loadFilter?.test("/some/other/route.ts")).toBe(true);
    expect(cap.loadFilter?.test("/some/other/data.json")).toBe(false);

    expect(cap.load?.({ path: "/some/other/route.ts" })).toBeUndefined();
  });
});
