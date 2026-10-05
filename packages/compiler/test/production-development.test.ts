/**
 * @fileoverview Production `Bun.serve` hardening codegen.
 *
 * Bun derives its `development` flag from the RUNTIME
 * `NODE_ENV !== "production"`. A production-built artifact that is launched
 * without `NODE_ENV=production` would therefore serve Bun's dev error page for
 * any error that escapes the generated wrapper — leaking the error message,
 * stack frames, file paths and source lines. The compiler bakes the BUILD
 * shape into `__serveOptions.development = false` so a prod artifact stays
 * hard regardless of the launch environment (the same contract as
 * `__IGNEX_PROD_BUILD`). Dev-shaped artifacts keep Bun's default so the local
 * error page still works. These tests pin both emission shapes.
 */
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { materializeFixture } from "./helpers";

const build = async (production: boolean) => {
  const { routesDir, outDir } = materializeFixture("basic");
  return buildAsync({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: false,
    generateTypes: false,
    generateOpenAPI: false,
    generateClient: false,
    production,
  });
};

describe("production Bun.serve hardening codegen", () => {
  it("pins development:false into a production-shaped artifact", async () => {
    const result = await build(true);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("__serveOptions.development = false;");
    // …and it reaches Bun.serve.
    expect(result.code).toContain("Bun.serve(__serveOptions)");
  });

  it("leaves Bun's NODE_ENV default for a dev-shaped artifact", async () => {
    const result = await build(false);
    expect(result.errors).toHaveLength(0);
    expect(result.code).not.toContain("__serveOptions.development");
  });
});
