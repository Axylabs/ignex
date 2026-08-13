/**
 * Route-granular cache fingerprint tests — the parse-level incrementality
 * foundation. Covers the pure fingerprint/diff functions plus the on-disk
 * `computeRouteChanges` flow (storeCache then edit one route).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeRouteChanges,
  computeRouteFingerprint,
  diffRouteFingerprints,
  fingerprintRouteFiles,
  type RouteFingerprint,
  storeCache,
} from "../src/cache";
import { DiagnosticCollector } from "../src/diagnostics";
import { mergeOptions } from "../src/index";
import { silentLogger } from "../src/logger";

const makeCtx = () => ({
  logger: silentLogger,
  diagnostics: new DiagnosticCollector(),
});

const tmpDirs: string[] = [];
const tmpDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-route-cache-"));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const makeOpts = (routesDir: string, outDir: string) =>
  mergeOptions({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: true,
    minify: false,
    sourceMap: false,
  });

describe("computeRouteFingerprint", () => {
  it("is deterministic for identical input", () => {
    expect(computeRouteFingerprint("a.get.ts", "export default () => 1;")).toBe(
      computeRouteFingerprint("a.get.ts", "export default () => 1;"),
    );
  });

  it("changes when the route content changes", () => {
    expect(computeRouteFingerprint("a.get.ts", "export default () => 1;")).not.toBe(
      computeRouteFingerprint("a.get.ts", "export default () => 2;"),
    );
  });

  it("changes when the relative path changes", () => {
    expect(computeRouteFingerprint("a.get.ts", "export default () => 1;")).not.toBe(
      computeRouteFingerprint("b.get.ts", "export default () => 1;"),
    );
  });

  it("changes when the codegen version changes", () => {
    expect(computeRouteFingerprint("a.get.ts", "export default () => 1;", "0.6.0")).not.toBe(
      computeRouteFingerprint("a.get.ts", "export default () => 1;", "0.7.0"),
    );
  });
});

describe("fingerprintRouteFiles", () => {
  it("returns a sorted per-route fingerprint set for the routes dir", () => {
    const dir = tmpDir();
    const routesDir = join(dir, "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "b.get.ts"), "export default () => 2;");
    writeFileSync(join(routesDir, "a.get.ts"), "export default () => 1;");
    writeFileSync(join(routesDir, "c.post.ts"), "export default () => 3;");

    const fps = fingerprintRouteFiles(makeOpts(routesDir, join(dir, "out")));

    expect(fps.map((f) => f.relPath)).toEqual(["a.get.ts", "b.get.ts", "c.post.ts"]);
    for (const f of fps) expect(f.fingerprint).toBeTruthy();
  });

  it("ignores non-route files and .d.ts declarations", () => {
    const dir = tmpDir();
    const routesDir = join(dir, "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "a.get.ts"), "export default () => 1;");
    writeFileSync(join(routesDir, "helper.ts"), "export const x = 1;");
    writeFileSync(join(routesDir, "types.d.ts"), "export type T = string;");
    writeFileSync(join(routesDir, "notes.txt"), "not a route");

    const fps = fingerprintRouteFiles(makeOpts(routesDir, join(dir, "out")));

    // `helper.ts` IS a route source file by discovery rules (not `.d.ts`).
    expect(fps.map((f) => f.relPath).sort()).toEqual(["a.get.ts", "helper.ts"]);
  });

  it("returns [] when the routes dir does not exist", () => {
    const dir = tmpDir();
    const fps = fingerprintRouteFiles(makeOpts(join(dir, "nope"), join(dir, "out")));
    expect(fps).toEqual([]);
  });
});

describe("diffRouteFingerprints", () => {
  const a = (relPath: string, fingerprint: string): RouteFingerprint => ({ relPath, fingerprint });

  it("marks everything unchanged when the sets are identical", () => {
    const prev = [a("a.get.ts", "1"), a("b.get.ts", "2")];
    const diff = diffRouteFingerprints(prev, [...prev].reverse());
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged.sort()).toEqual(["a.get.ts", "b.get.ts"]);
  });

  it("marks exactly the edited route as changed", () => {
    const prev = [a("a.get.ts", "1"), a("b.get.ts", "2"), a("c.get.ts", "3")];
    const current = [a("a.get.ts", "1"), a("b.get.ts", "2"), a("c.get.ts", "4")];
    const diff = diffRouteFingerprints(prev, current);
    expect(diff.changed).toEqual(["c.get.ts"]);
    expect(diff.unchanged).toEqual(["a.get.ts", "b.get.ts"]);
  });

  it("treats an added route as changed", () => {
    const diff = diffRouteFingerprints(
      [a("a.get.ts", "1")],
      [a("a.get.ts", "1"), a("b.get.ts", "2")],
    );
    expect(diff.changed).toEqual(["b.get.ts"]);
    expect(diff.unchanged).toEqual(["a.get.ts"]);
  });

  it("treats a deleted route as changed", () => {
    const diff = diffRouteFingerprints(
      [a("a.get.ts", "1"), a("b.get.ts", "2")],
      [a("a.get.ts", "1")],
    );
    expect(diff.changed).toEqual(["b.get.ts"]);
    expect(diff.unchanged).toEqual(["a.get.ts"]);
  });

  it("is order-independent", () => {
    const prev = [a("a.get.ts", "1"), a("b.get.ts", "2"), a("c.get.ts", "3")];
    const current = [a("c.get.ts", "9"), a("a.get.ts", "1"), a("d.get.ts", "4")];
    const fwd = diffRouteFingerprints(prev, current);
    const rev = diffRouteFingerprints([...current].reverse(), [...prev].reverse());
    expect(rev).toEqual(fwd);
  });

  it("partitions the union and is order-independent (property)", () => {
    const arbSet = fc.uniqueArray(fc.record({ relPath: fc.string(), fingerprint: fc.string() }), {
      selector: (r) => r.relPath,
      maxLength: 10,
    });

    fc.assert(
      fc.property(arbSet, arbSet, (prev, current) => {
        const a = diffRouteFingerprints(prev, current);
        const b = diffRouteFingerprints([...current].reverse(), [...prev].reverse());

        // Order-independence: sorted buckets are equal regardless of input order.
        expect(b).toEqual(a);

        // Partition: every path in the union appears in exactly one bucket.
        const union = new Set([...prev, ...current].map((r) => r.relPath));
        const inBuckets = new Set([...a.changed, ...a.unchanged]);
        expect(inBuckets.size).toBe(union.size);
        for (const p of union) expect(inBuckets.has(p)).toBe(true);

        // No path lands in both buckets.
        const changedSet = new Set(a.changed);
        for (const p of a.unchanged) expect(changedSet.has(p)).toBe(false);

        // Unchanged ⇔ fingerprint present and equal in both sets.
        const prevByPath = new Map(prev.map((r) => [r.relPath, r.fingerprint]));
        const curByPath = new Map(current.map((r) => [r.relPath, r.fingerprint]));
        for (const p of a.unchanged) {
          expect(prevByPath.get(p)).toBe(curByPath.get(p));
        }
        for (const p of a.changed) {
          expect(prevByPath.get(p)).not.toBe(curByPath.get(p));
        }
      }),
    );
  });
});

describe("computeRouteChanges (on-disk)", () => {
  const layout = () => {
    const dir = tmpDir();
    const routesDir = join(dir, "routes");
    const outDir = join(dir, "out");
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(routesDir, "a.get.ts"), "export default () => 1;");
    writeFileSync(join(routesDir, "b.get.ts"), "export default () => 2;");
    writeFileSync(join(routesDir, "c.get.ts"), "export default () => 3;");
    return { routesDir, outDir };
  };

  it("returns undefined when no cache has been stored", () => {
    const { routesDir, outDir } = layout();
    expect(computeRouteChanges(makeOpts(routesDir, outDir))).toBeUndefined();
  });

  it("reports no changes when nothing changed since storeCache", async () => {
    const { routesDir, outDir } = layout();
    const opts = makeOpts(routesDir, outDir);
    await storeCache(opts, makeCtx(), join(outDir, "server.js"));

    const changes = computeRouteChanges(opts);
    expect(changes).toBeDefined();
    expect(changes?.changed).toEqual([]);
    expect(changes?.unchanged.sort()).toEqual(["a.get.ts", "b.get.ts", "c.get.ts"]);
  });

  it("reports exactly the edited route after storeCache", async () => {
    const { routesDir, outDir } = layout();
    const opts = makeOpts(routesDir, outDir);
    await storeCache(opts, makeCtx(), join(outDir, "server.js"));

    writeFileSync(join(routesDir, "b.get.ts"), "export default () => 99;");

    const changes = computeRouteChanges(opts);
    expect(changes?.changed).toEqual(["b.get.ts"]);
    expect(changes?.unchanged).toEqual(["a.get.ts", "c.get.ts"]);
  });

  it("reports added and deleted routes as changed", async () => {
    const { routesDir, outDir } = layout();
    const opts = makeOpts(routesDir, outDir);
    await storeCache(opts, makeCtx(), join(outDir, "server.js"));

    writeFileSync(join(routesDir, "d.post.ts"), "export default () => 4;");
    rmSync(join(routesDir, "a.get.ts"));

    const changes = computeRouteChanges(opts);
    expect(changes?.changed.sort()).toEqual(["a.get.ts", "d.post.ts"]);
    expect(changes?.unchanged).toEqual(["b.get.ts", "c.get.ts"]);
  });
});
