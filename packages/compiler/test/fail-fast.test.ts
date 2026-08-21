/**
 * Fail-fast regression tests (2026-08-19).
 *
 * Previously the compiler silently dropped broken routes: a route file with a
 * missing/misspelled handler export, a syntax error, or a duplicate static
 * route produced a build that "succeeded" and a route that 404'd at runtime.
 * These tests pin the new fail-fast behavior:
 *   - no handler export → `IGN_NO_HANDLER_EXPORT` error (build fails);
 *   - syntax error in a route module → `IGN_PARSE_ERROR` error (build fails);
 *   - exact duplicate static routes → `IGN_ROUTE_CONFLICT` error under
 *     `strictRouteConflicts` (and stay a DeadRoute warning by default).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync, type CompilationError } from "../src/index";
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

/** Await a build, returning the thrown CompilationError (or null on success). */
const compileError = async (
  options: ReturnType<typeof baseOptions>,
): Promise<CompilationError | null> => {
  try {
    await buildAsync(options);
    return null;
  } catch (error) {
    return error as CompilationError;
  }
};

const writeRoute = (
  layout: ReturnType<typeof materializeFixture>,
  rel: string,
  content: string,
) => {
  const abs = join(layout.routesDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};

describe("fail-fast: missing handler export", () => {
  it("fails the build with IGN_NO_HANDLER_EXPORT for a route file with no handler", async () => {
    const layout = materializeFixture("basic");
    // A route filename with NO handler export (e.g. a misspelled `httpGet`).
    writeRoute(layout, "broken.get.ts", "const x = 1;\n");

    const err = await compileError(baseOptions(layout));

    expect(err?.code).toBe("COMPILE_FAILED");
    expect(err?.diagnostics.some((d) => d.code === "IGN_NO_HANDLER_EXPORT")).toBe(true);
    expect(err?.diagnostics.some((d) => d.file?.endsWith("broken.get.ts"))).toBe(true);
  });
});

describe("fail-fast: route module syntax error", () => {
  it("fails the build with IGN_PARSE_ERROR for an unparseable route module", async () => {
    const layout = materializeFixture("basic");
    writeRoute(layout, "broken-parse.get.ts", "export default (((\n");

    const err = await compileError(baseOptions(layout));

    expect(err?.code).toBe("COMPILE_FAILED");
    expect(err?.diagnostics.some((d) => d.code === "IGN_PARSE_ERROR")).toBe(true);
  });
});

describe("fail-fast: duplicate static routes under strictRouteConflicts", () => {
  it("is a hard error when strictRouteConflicts is on", async () => {
    const layout = materializeFixture("basic");
    // Two files resolving to the same GET route: `dup.get.ts` → GET /dup and
    // `dup/index.get.ts` → GET /dup (index maps to the parent path).
    writeRoute(layout, "dup.get.ts", handler);
    writeRoute(layout, "dup/index.get.ts", handler);

    const err = await compileError({
      ...baseOptions(layout),
      strictRouteConflicts: true,
    });

    expect(err?.code).toBe("COMPILE_FAILED");
    expect(err?.diagnostics.some((d) => d.code === "IGN_ROUTE_CONFLICT")).toBe(true);
  });

  it("stays a DeadRoute warning by default (non-fatal, dedup wins)", async () => {
    const layout = materializeFixture("basic");
    writeRoute(layout, "dup.get.ts", handler);
    writeRoute(layout, "dup/index.get.ts", handler);

    const result = await buildAsync(baseOptions(layout));

    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "IGN_ROUTE_DEAD")).toBe(true);
  });
});
