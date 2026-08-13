import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProject, findServerEntry } from "../src/utils/compiler.js";

describe("buildProject (integration with @ignex/compiler)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ignex-cli-build-"));
    mkdirSync(join(dir, "src/routes"), { recursive: true });
    writeFileSync(join(dir, "src/routes", "index.get.ts"), 'export default () => "ok";\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("roots relative compiler paths against the project root", async () => {
    const { opts } = await buildProject(dir, {});
    expect(opts.routesDir).toBe(join(dir, "src/routes"));
    expect(opts.outDir).toBe(join(dir, ".ignex"));
  });

  it("produces a runnable server entry in the rooted outDir", async () => {
    const { opts } = await buildProject(dir, {});
    const entry = await findServerEntry(dir, opts);
    expect(entry).toBe(join(dir, ".ignex", "server.js"));
    expect(entry).toBeDefined();
    expect(existsSync(entry as string)).toBe(true);
  });

  it("emits the full SDK artifact set by default", async () => {
    const { opts } = await buildProject(dir, {});
    for (const file of [
      "client.ts",
      "client.d.ts",
      "routes.d.ts",
      "openapi.json",
      "manifest.json",
    ]) {
      expect(existsSync(join(opts.outDir, file)), `missing ${file}`).toBe(true);
    }
  });

  it("suppresses artifact generation at optimizationLevel 0 (preset gate)", async () => {
    const dir0 = mkdtempSync(join(tmpdir(), "ignex-cli-build-opt0-"));
    try {
      mkdirSync(join(dir0, "src/routes"), { recursive: true });
      writeFileSync(join(dir0, "src/routes", "index.get.ts"), 'export default () => "ok";\n');
      // Config-driven `optimizationLevel: 0` flips all generate* flags off.
      writeFileSync(join(dir0, "ignex.config.json"), JSON.stringify({ optimizationLevel: 0 }));

      const { opts } = await buildProject(dir0, {});
      for (const file of ["client.ts", "client.d.ts", "routes.d.ts", "openapi.json"]) {
        expect(existsSync(join(opts.outDir, file)), `expected ${file} to be suppressed`).toBe(
          false,
        );
      }
      // The manifest is always emitted, regardless of the preset.
      expect(existsSync(join(opts.outDir, "manifest.json"))).toBe(true);
    } finally {
      rmSync(dir0, { recursive: true, force: true });
    }
  });
});
