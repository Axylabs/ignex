/**
 * @fileoverview Enterprise BUILD-ISOLATION + determinism suite.
 *
 * The compiler is a long-lived module: two builds running in one process must
 * behave as though each ran in a clean process. Pins:
 *  - determinism: the same source compiled to two different output dirs emits
 *    byte-identical server code, OpenAPI spec, and manifest (no timestamps,
 *    no wall-clock or process-order bleed);
 *  - failure hygiene: a build that throws on a malformed route leaves NO
 *    partial artifact in the output dir (no half-written spec/bundle);
 *  - isolation: two interleaved builds on distinct dirs never cross-pollinate
 *    generated ids, route metadata, or artifacts.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { materializeFixture } from "./helpers";

const baseOptions = (layout: ReturnType<typeof materializeFixture>) => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,
  precompileValidators: true,
  precompileSerializers: true,
});

const handler = 'export default () => new Response("ok");\n';

const writeRoute = (
  layout: ReturnType<typeof materializeFixture>,
  rel: string,
  content: string,
) => {
  const abs = join(layout.routesDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};

describe("build determinism — one source, two output dirs", () => {
  it("emits byte-identical server code and identical spec/manifest artifacts", async () => {
    const layout = materializeFixture("basic");
    const outA = join(layout.outDir, "dist-a");
    const outB = join(layout.outDir, "dist-b");
    const build = (outDir: string) => buildAsync({ ...baseOptions(layout), outDir });

    const first = await build(outA);
    const second = await build(outB);

    expect(first.errors).toHaveLength(0);
    expect(second.errors).toHaveLength(0);

    // The authoritative emitted server is a pure function of the routes.
    expect(second.code).toBe(first.code);

    // Generated artifacts are byte-identical across the two output dirs.
    for (const artifact of [
      "openapi.json",
      "manifest.json",
      "routes.d.ts",
      "client.ts",
      "client.d.ts",
    ]) {
      const bytesA = readFileSync(join(outA, artifact), "utf8");
      const bytesB = readFileSync(join(outB, artifact), "utf8");
      expect(bytesB).toBe(bytesA);
    }
  });
});

describe("build failure hygiene — no partial artifacts", () => {
  it("a malformed route build throws and leaves the output dir EMPTY", async () => {
    const layout = materializeFixture("basic");
    const dist = join(layout.outDir, "dist-fail");
    mkdirSync(dist);
    expect(readdirSync(dist)).toHaveLength(0);

    writeRoute(layout, "broken-parse.get.ts", "export default (((\n");

    await expect(buildAsync({ ...baseOptions(layout), outDir: dist })).rejects.toThrow();

    // The output dir must not contain a half-written spec, bundle, manifest,
    // or entry file — a failed build is a failed build, not a corrupt one.
    expect(readdirSync(dist)).toHaveLength(0);
  });
});

describe("build isolation — interleaved builds never bleed", () => {
  it("two concurrent builds on distinct dirs emit only their own routes", async () => {
    const layoutA = materializeFixture("basic");
    const layoutB = materializeFixture("basic");
    writeRoute(layoutA, "alpha.get.ts", handler);
    writeRoute(layoutB, "beta.post.ts", handler);

    const [a, b] = await Promise.all([
      buildAsync(baseOptions(layoutA)),
      buildAsync(baseOptions(layoutB)),
    ]);

    expect(a.errors).toHaveLength(0);
    expect(b.errors).toHaveLength(0);

    // Each emitted server contains its own route and is free of the other's —
    // a shared id/registry registry would leak one build into the other.
    expect(a.code).toContain("/alpha");
    expect(a.code).not.toContain("/beta");
    expect(b.code).toContain("/beta");
    expect(b.code).not.toContain("/alpha");

    // And the on-disk artifacts never cross: A's spec/manifest carry no trace
    // of B's route, and vice versa.
    const manifestA = readFileSync(join(layoutA.outDir, "manifest.json"), "utf8");
    const manifestB = readFileSync(join(layoutB.outDir, "manifest.json"), "utf8");
    expect(manifestA).not.toContain("beta");
    expect(manifestB).not.toContain("alpha");
    const openapiA = readFileSync(join(layoutA.outDir, "openapi.json"), "utf8");
    const openapiB = readFileSync(join(layoutB.outDir, "openapi.json"), "utf8");
    expect(openapiA).not.toContain("/beta");
    expect(openapiB).not.toContain("/alpha");
  });
});
