import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { type FixtureLayout, fixturePath, materializeFixture } from "./helpers";

const baseOptions = (layout: FixtureLayout) => ({
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

describe("compile (end-to-end)", () => {
  it("compiles the basic fixture and writes artifacts", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync(baseOptions(layout));

    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("Bun.serve");
    expect(result.code).toContain("__routes");

    expect(existsSync(join(layout.outDir, "server.js"))).toBe(true);
    expect(existsSync(join(layout.outDir, "routes.d.ts"))).toBe(true);
    expect(existsSync(join(layout.outDir, "openapi.json"))).toBe(true);
    expect(existsSync(join(layout.outDir, "manifest.json"))).toBe(true);
  });

  it("is deterministic across builds", async () => {
    const a = materializeFixture("basic");
    const b = materializeFixture("basic");

    const ra = await buildAsync(baseOptions(a));
    const rb = await buildAsync(baseOptions(b));

    expect(ra.code).toBe(rb.code);
  });

  it("inlines self-contained handlers and wires the full runtime for ctx routes", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync(baseOptions(layout));

    // echo.post is a pure, no-import handler → inlined into the server.
    expect(result.code).toContain("Inlined route handler");

    // health.get uses a non-pure handler and needs the json reply helper.
    expect(result.code).toContain("jsonReply");
  });

  it("prunes unused runtime helpers for constant-only apps", async () => {
    const layout = materializeFixture("constant-only");
    const result = await buildAsync(baseOptions(layout));

    expect(result.errors).toHaveLength(0);

    // Constant routes never need reply/finalize helpers.
    expect(result.code).not.toContain("jsonReply");
    expect(result.code).not.toContain("textReply");
    expect(result.code).not.toContain("__finalize");
  });

  it("emits a single __appConfig import when an app config is present", async () => {
    const layout = materializeFixture("basic");
    const appConfig = fixturePath("basic", "app.config.ts");

    const result = await buildAsync({
      ...baseOptions(layout),
      appConfig,
    });

    const matches = result.code.match(/import \* as __appConfig/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(result.code).toContain("mergeLifeCycle");
  });

  it("delegates hook execution to the shared core runHooks (single source of truth)", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync(baseOptions(layout));

    // The generated server imports runHooks from @flux/core and no longer
    // embeds its own __runHooks copy.
    expect(result.code).toMatch(/import \{[^}]*\brunHooks\b[^}]*\} from "@flux\/core"/);
    expect(result.code).not.toContain("function __runHooks");
    expect(result.code).not.toContain("__runHooks");
  });

  it("runs the full post-handler lifecycle (mapResponse + afterResponse) when an app config is present", async () => {
    const layout = materializeFixture("basic");
    const appConfig = fixturePath("basic", "app.config.ts");

    const result = await buildAsync({
      ...baseOptions(layout),
      appConfig,
    });

    expect(result.code).toContain("__lc.mapResponse");
    expect(result.code).toContain("__lc.afterResponse");
    expect(result.code).toContain("__lc.beforeHandle");
    expect(result.code).toContain("__lc.afterHandle");
    // start/request/parse/transform now run in the compiled pre-chain too.
    expect(result.code).toContain("__preParseStages");
  });

  it("splits 405 lookups into a static map + dynamic regex scan", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync(baseOptions(layout));

    // Static path lookup is an O(1) frozen object.
    expect(result.code).toContain("const __allowedStatic = Object.freeze({");
    // Dynamic patterns still use regexes, but in a separate list.
    expect(result.code).toContain("const __allowedDynamic = [");
    expect(result.code).not.toContain("const __allowed = [");

    // __allowFor checks the static map first, then scans dynamic entries.
    expect(result.code).toContain("__allowedStatic[pathname]");
    expect(result.code).toContain("for (const entry of __allowedDynamic)");
  });

  it("wires trace headers and access logging when enabled", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync({
      ...baseOptions(layout),
      enableTraceHeaders: true,
      enableAccessLog: true,
    });

    expect(result.code).toContain("const __TRACE = true");
    expect(result.code).toContain("const __ACCESS_LOG = true");
    // __applySet delegates to the shared core helper with the trace flag.
    expect(result.code).toContain("applySet(response, set, requestId, __TRACE)");
    expect(result.code).toContain("__applySet(response, ctx.set, ctx.requestId)");
    expect(result.code).toContain("requestId: ctx.requestId");
    expect(result.code).toContain("ctx.startTime");
  });

  it("keeps observability off by default (perf-first)", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync(baseOptions(layout));

    // Per-request logging and trace headers are opt-in so the default hot path
    // stays allocation-light. Constant responses stay hoisted (no context).
    expect(result.code).toContain("const __TRACE = false");
    expect(result.code).toContain("const __ACCESS_LOG = false");
  });

  it("does not hoist constant responses when an app config (lifecycle) is present", async () => {
    const layout = materializeFixture("basic");
    const result = await buildAsync({
      ...baseOptions(layout),
      appConfig: fixturePath("basic", "app.config.ts"),
    });

    // Hoisting a constant to a frozen Response would bypass plugins/hooks/
    // ctx.set/error handling. When a global lifecycle may exist we must NOT
    // hoist — the route runs through the shared pre-chain instead.
    expect(result.code).not.toContain("const INIT_");
    expect(result.code).toContain("__preParseStages");
    expect(result.code).toContain("applySet(response, set, requestId, __TRACE)");
  });

  it("still hoists constant responses in pure-compiler mode (no app config)", async () => {
    const layout = materializeFixture("constant-only");
    const result = await buildAsync(baseOptions(layout));

    expect(result.code).toContain("const INIT_");
  });
});
