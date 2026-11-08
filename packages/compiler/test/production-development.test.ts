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
 *
 * The same build-shape authority governs error-detail exposure:
 * `mergeOptions` (validate.ts) forces `exposeErrorDetails: false` onto a
 * production-shaped build whose option is unset, so an artifact built in a
 * shell with NODE_ENV unset still fails closed. These tests pin the emission
 * END-TO-END (mergeOptions → getConfig → `EXPOSE_ERRORS` const) and the loud
 * `IGN_ERRORS_EXPOSED` warning for an explicit opt-in.
 */
import { describe, expect, it } from "vitest";
import { buildAsync, type CompilerOptions } from "../src/index";
import { materializeFixture } from "./helpers";

const build = async (production: boolean, extra: Partial<CompilerOptions> = {}) => {
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
    ...extra,
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

describe("error-detail exposure codegen", () => {
  it("bakes EXPOSE_ERRORS=false into a production-shaped artifact built without NODE_ENV", async () => {
    const result = await build(true);
    expect(result.errors).toHaveLength(0);
    // The emission-level pin for mergeOptions' production override: even when
    // the BUILD shell has NODE_ENV unset, the artifact fails closed.
    expect(result.code).toContain("const EXPOSE_ERRORS = false;");
    expect(result.warnings).toHaveLength(0);
  });

  it("bakes EXPOSE_ERRORS=true for a dev-shaped artifact", async () => {
    const result = await build(false);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("const EXPOSE_ERRORS = true;");
  });

  it("honors an explicit opt-in but says so loudly (IGN_ERRORS_EXPOSED)", async () => {
    const result = await build(true, { exposeErrorDetails: true });
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("const EXPOSE_ERRORS = true;");
    expect(result.warnings.some((w) => w.code === "IGN_ERRORS_EXPOSED")).toBe(true);
  });

  it("stays silent when a dev-shaped build exposes details", async () => {
    const result = await build(false, { exposeErrorDetails: true });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "IGN_ERRORS_EXPOSED")).toBe(false);
  });
});
