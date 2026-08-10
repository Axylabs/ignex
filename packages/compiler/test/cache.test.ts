import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeFingerprint, storeCache, tryCachedBuild } from "../src/cache";
import { DiagnosticCollector } from "../src/diagnostics";
import { mergeOptions } from "../src/index";
import { silentLogger } from "../src/logger";

const makeLayout = () => {
  const outDir = mkdtempSync(join(tmpdir(), "flux-cache-"));
  const routesDir = join(outDir, "routes");
  mkdirSync(routesDir, { recursive: true });
  writeFileSync(join(routesDir, "index.get.ts"), "export default () => 'hi';\n");
  return { outDir, routesDir };
};

const makeOpts = () => {
  const { outDir, routesDir } = makeLayout();
  const opts = mergeOptions({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: true,
    minify: false,
    sourceMap: false,
  });
  return { opts, outDir, routesDir };
};

const makeCtx = () => ({
  logger: silentLogger,
  diagnostics: new DiagnosticCollector(),
});

describe("incremental cache", () => {
  it("fingerprint changes when a route file changes", () => {
    const { opts, routesDir } = makeOpts();
    const before = computeFingerprint(opts);

    writeFileSync(join(routesDir, "index.get.ts"), "export default () => 'changed';\n");

    const after = computeFingerprint(opts);
    expect(before).not.toBe(after);
  });

  it("returns undefined when no cache has been stored", async () => {
    const { opts } = makeOpts();
    const hit = await tryCachedBuild(opts, makeCtx());
    expect(hit).toBeUndefined();
  });

  it("hits the cache after storeCache when the output still exists", async () => {
    const { opts, outDir } = makeOpts();
    const ctx = makeCtx();
    const outPath = join(outDir, "server.js");

    await writeFile(outPath, "export default {};\n");
    await storeCache(opts, ctx, outPath);

    const hit = await tryCachedBuild(opts, ctx);
    expect(hit).toBeDefined();
    if (hit) {
      expect(hit.outFile).toBe(outPath);
      expect(hit.code).toContain("export default");
    }
  });

  it("misses the cache when a route changes after storeCache", async () => {
    const { opts, routesDir, outDir } = makeOpts();
    const ctx = makeCtx();
    const outPath = join(outDir, "server.js");

    await writeFile(outPath, "export default {};\n");
    await storeCache(opts, ctx, outPath);

    writeFileSync(join(routesDir, "index.get.ts"), "export default () => 'new';\n");

    const hit = await tryCachedBuild(opts, ctx);
    expect(hit).toBeUndefined();
  });
});
