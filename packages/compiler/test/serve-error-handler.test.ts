/**
 * @fileoverview Last-resort `Bun.serve` error-boundary codegen.
 *
 * The generated request wrapper already converts a handler/pipeline throw into
 * the canonical JSON envelope. A throw that escapes it (a framework-level bug,
 * a route-table edge) would otherwise be rendered by Bun itself — its dev error
 * page, or an opaque default. The bootstrap wires `__serveOptions.error` to
 * `__handleError`, so the client still gets the framework envelope (static
 * security headers included) and the failure is reported as a Fault, on every
 * build shape and independent of `NODE_ENV`.
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

describe("serve error-boundary codegen", () => {
  it("wires the last-resort handler to the canonical error boundary", async () => {
    const result = await build(false);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain(
      "__serveOptions.error = (__err) => __handleError(__err, undefined);",
    );
    // The boundary helper it delegates to must be present in the emission.
    expect(result.code).toContain("async function __handleError(err, ctx)");
  });

  it("is emitted for production-shaped builds too", async () => {
    const result = await build(true);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain(
      "__serveOptions.error = (__err) => __handleError(__err, undefined);",
    );
  });

  it("reports a bind/startup failure instead of dying with a raw stack", async () => {
    const result = await build(false);
    expect(result.errors).toHaveLength(0);
    // A boot failure (EADDRINUSE, bad TLS, unusable socket) must be classified
    // and actionable, then exit non-zero so a supervisor restarts.
    expect(result.code).toContain("try {\n  __server = Bun.serve(__serveOptions);");
    expect(result.code).toMatch(/catch \(__err\) \{[\s\S]*?reportFault\(__err, \{ title:/);
    expect(result.code).toContain('title: "ignex failed to start');
    expect(result.code).toMatch(/catch \(__err\) \{[\s\S]*?process\.exit\(1\);/);
  });

  it("never swallows a throwing error-stage hook silently", async () => {
    const result = await build(false);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain('console.error("[ignex] error-stage hook threw:", __hookErr);');
  });
});
