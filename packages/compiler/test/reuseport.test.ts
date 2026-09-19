/**
 * @fileoverview `reusePort` codegen.
 *
 * `reusePort` lets several processes of the same artifact share a port via
 * `SO_REUSEPORT` (the measured +78% RPS multi-process lever — see
 * `packages/compiler/README.md` §Multi-process scaling). The compiler bakes the
 * build option into a literal `true` when set, and otherwise defers to
 * `server.reusePort` in the runtime app config, then `IGNEX_REUSE_PORT=1` in the
 * environment. This pins the emission shapes and that the option reaches
 * `Bun.serve` so the lever cannot silently regress.
 */
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { materializeFixture } from "./helpers";

const build = async (reusePort: boolean | undefined) => {
  const { routesDir, outDir } = materializeFixture("basic");
  return buildAsync({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: false,
    generateTypes: false,
    generateOpenAPI: false,
    generateClient: false,
    ...(reusePort === undefined ? {} : { reusePort }),
  });
};

describe("reusePort codegen", () => {
  it("bakes an unconditional true when the build option is set", async () => {
    const result = await build(true);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("reusePort: true,");
  });

  it("defers to the runtime server config when the build option is unset", async () => {
    const result = await build(false);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain(
      "reusePort: (__serverCfg.reusePort ?? process.env.IGNEX_REUSE_PORT === '1'),",
    );
  });

  it("emits the runtime fallback when the option is omitted (default false)", async () => {
    const result = await build(undefined);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain(
      "reusePort: (__serverCfg.reusePort ?? process.env.IGNEX_REUSE_PORT === '1'),",
    );
  });

  it("honours IGNEX_REUSE_PORT=1 when neither the build option nor app config sets it", async () => {
    const result = await build(undefined);
    expect(result.code).toContain("process.env.IGNEX_REUSE_PORT === '1'");
  });

  it("reaches Bun.serve through __serveOptions", async () => {
    const result = await build(true);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("reusePort: true,");
    expect(result.code).toContain("Bun.serve(__serveOptions)");
  });
});
