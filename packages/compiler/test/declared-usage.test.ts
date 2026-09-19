/**
 * Declared plugin context-usage reading (WS2).
 *
 * A user plugin module may export a statically-parseable
 * `export const contextUsage = { ... }` so the compiler can attribute what the
 * plugin's hooks read off `ctx` and keep routes on the usage-specialized
 * tier. The reader is deliberately conservative: ANYTHING it cannot fully
 * establish returns `null` (opaque ⇒ full context), never a partial usage.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceManager } from "../src/frontend";
import { resolveAppConfig } from "../src/phases/analysis/app-config";
import { readDeclaredContextUsage } from "../src/phases/analysis/declared-usage";
import { resolveGlobalPluginUsage } from "../src/phases/analysis/internal-plugins";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const write = (name: string, content: string): string => {
  const p = join(tmp as string, name);
  writeFileSync(p, content);
  return p;
};

/** Spin up a temp fixture dir with a fake app config + plugin modules. */
const setup = (): { sources: SourceManager; fromPath: string; factoryFromPath: string } => {
  tmp = mkdtempSync(join(tmpdir(), "ignex-declared-"));
  write("app.config.ts", "export const plugins = [];");
  write(
    "declared-plugin.ts",
    `export const contextUsage = { headers: true, method: true };\nexport const plugin = { name: "p", onRequest() {} };`,
  );
  write("opaque-plugin.ts", `export const plugin = { name: "q", onRequest() {} };`);
  write("computed-usage.ts", `export const contextUsage = makeUsage();`);
  write("bad-member.ts", `export const contextUsage = { nope: true };`);
  write("non-true-value.ts", `export const contextUsage = { headers: "yes" };`);
  write(
    "duplicate-decl.ts",
    `export const contextUsage = { headers: true };\nexport const contextUsage = { method: true };`,
  );
  // Factory-style plugin: analyzePluginCalls requires CallExpression elements.
  write(
    "factory-declared.ts",
    `export const contextUsage = { headers: true, method: true };\nexport const plugin = () => ({ name: "declared", onRequest() {} });`,
  );
  write("factory-opaque.ts", `export const plugin = () => ({ name: "opaque", onRequest() {} });`);
  write(
    "factory-app.config.ts",
    `import { plugin as makeDecl } from "./factory-declared";\nimport { plugin as makeOpaq } from "./factory-opaque";\nimport { cors } from "@ignex/core";\nexport const plugins = [cors({ origin: ["https://example.com"] }), makeDecl()];\nexport const server = { port: 3000 };`,
  );
  write(
    "factory-app-opaque.config.ts",
    `import { plugin as makeOpaq } from "./factory-opaque";\nimport { cors } from "@ignex/core";\nexport const plugins = [cors({ origin: ["https://example.com"] }), makeOpaq()];\nexport const server = { port: 3000 };`,
  );
  return {
    sources: new SourceManager(),
    fromPath: join(tmp, "app.config.ts"),
    factoryFromPath: join(tmp, "factory-app.config.ts"),
  };
};

describe("readDeclaredContextUsage", () => {
  it("reads a statically-parseable contextUsage literal export", () => {
    const { sources, fromPath } = setup();
    const usage = readDeclaredContextUsage(sources, "./declared-plugin", fromPath);
    expect(usage).not.toBeNull();
    expect(usage?.headers).toBe(true);
    expect(usage?.method).toBe(true);
    // Members not declared stay false — no silent full-context assumption.
    expect(usage?.body).toBe(false);
    expect(usage?.req).toBe(false);
  });

  it("returns null for a module with no declaration", () => {
    const { sources, fromPath } = setup();
    expect(readDeclaredContextUsage(sources, "./opaque-plugin", fromPath)).toBeNull();
  });

  it("returns null when the initializer is not a literal object", () => {
    const { sources, fromPath } = setup();
    expect(readDeclaredContextUsage(sources, "./computed-usage", fromPath)).toBeNull();
  });

  it("returns null when a member is not a known ContextUsage key", () => {
    const { sources, fromPath } = setup();
    expect(readDeclaredContextUsage(sources, "./bad-member", fromPath)).toBeNull();
  });

  it("returns null when a declared member is not literal true", () => {
    const { sources, fromPath } = setup();
    expect(readDeclaredContextUsage(sources, "./non-true-value", fromPath)).toBeNull();
  });

  it("returns null when the module cannot be resolved", () => {
    const { sources, fromPath } = setup();
    expect(readDeclaredContextUsage(sources, "./does-not-exist", fromPath)).toBeNull();
  });

  it("returns null when contextUsage is declared more than once", () => {
    const { sources, fromPath } = setup();
    expect(readDeclaredContextUsage(sources, "./duplicate-decl", fromPath)).toBeNull();
  });
});

describe("resolveGlobalPluginUsage (extended)", () => {
  it("satisfies a user plugin through its module declaration", () => {
    const { sources, fromPath } = setup();
    const { usage } = resolveGlobalPluginUsage(
      [{ name: "plugin", source: "./declared-plugin" }],
      true,
      sources,
      fromPath,
    );
    expect(usage).not.toBeNull();
    expect(usage?.headers).toBe(true);
    expect(usage?.method).toBe(true);
  });

  it("keeps the layer opaque when a user plugin declares nothing", () => {
    const { sources, fromPath } = setup();
    const { usage } = resolveGlobalPluginUsage(
      [{ name: "plugin", source: "./opaque-plugin" }],
      true,
      sources,
      fromPath,
    );
    expect(usage).toBeNull();
  });

  it("still attributes internal plugins without the declaration reader", () => {
    const { usage } = resolveGlobalPluginUsage([{ name: "security", source: "@ignex/core" }], true);
    expect(usage?.headers).toBe(true);
    expect(usage?.req).toBe(true);
  });

  it("resolves the audited session/compression/openapi declarations", () => {
    // Each declaration is a correctness claim against the plugin's hook body —
    // the merge in `routes/context.ts` emits these exact members on every
    // specialized route, so a wrong audit hands the hook `undefined`.
    const session = resolveGlobalPluginUsage([{ name: "session", source: "@ignex/core" }], true);
    expect(session.usage).toMatchObject({ req: true, cookie: true, state: true });

    const compression = resolveGlobalPluginUsage(
      [{ name: "compression", source: "@ignex/core" }],
      true,
    );
    expect(compression.usage).toMatchObject({ headers: true });

    const openapi = resolveGlobalPluginUsage([{ name: "openapi", source: "@ignex/core" }], true);
    expect(openapi.usage).toMatchObject({ url: true });
  });

  it("treats a user plugin as opaque when no reader context is available", () => {
    const { usage } = resolveGlobalPluginUsage(
      [{ name: "plugin", source: "./declared-plugin" }],
      true,
    );
    expect(usage).toBeNull();
  });
});

describe("resolveAppConfig integration (factory-style user plugin)", () => {
  it("unlocks a non-null globalPluginUsage when the user plugin declares usage", () => {
    const { sources, factoryFromPath } = setup();
    const info = resolveAppConfig({ appConfig: factoryFromPath } as never, sources, {
      diagnostics: { warn() {} },
    } as never);
    expect(info?.globalPluginUsage).not.toBeNull();
    // cors (headers, method) merged with the declared user plugin (headers,
    // method) — both emittable, so the specialized tier stays available.
    expect(info?.globalPluginUsage?.headers).toBe(true);
    expect(info?.globalPluginUsage?.method).toBe(true);
  });

  it("stays opaque when the user plugin carries no declaration", () => {
    const { sources } = setup();
    const factoryFromPath = join(tmp as string, "factory-app-opaque.config.ts");
    const info = resolveAppConfig({ appConfig: factoryFromPath } as never, sources, {
      diagnostics: { warn() {} },
    } as never);
    expect(info?.globalPluginUsage).toBeNull();
  });
});
