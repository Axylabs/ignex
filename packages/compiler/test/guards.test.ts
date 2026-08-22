/**
 * Codegen tests for RBAC guards (`withGuards`) in the AOT pipeline.
 *
 * The compiler recognizes `withGuards(handler, guards)` as a route-handler
 * wrapper: the inner handler is extracted (so the route participates in the
 * route graph and can be inlined/optimized), and the guards are emitted as
 * module-level hook consts (`hasRole(...)` / `can(...)` / `canAll(...)` /
 * `requireAuthenticated`) wired into the route's pre-execution hook array —
 * plus imported from `@ignex/core`. Guarded routes are never constant-hoisted
 * (a frozen body would bypass the guards).
 */
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { type FixtureLayout, materializeFixture } from "./helpers";

const baseOptions = (layout: FixtureLayout, extra: Record<string, unknown> = {}) => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: false,
  generateOpenAPI: false,
  generateClient: false,
  precompileValidators: false,
  precompileSerializers: false,
  ...extra,
});

describe("RBAC guards (withGuards) AOT codegen", () => {
  it("emits guard hooks + imports and wires them into the route hook chain", async () => {
    const layout = materializeFixture("guards");
    const result = await buildAsync(baseOptions(layout));

    expect(result.errors).toHaveLength(0);

    // Guard expressions emitted as module-level consts (route-order agnostic).
    expect(result.code).toContain('hasRole("admin")');
    expect(result.code).toContain('can("users:read")');
    expect(result.code).toContain('canAll("orders:read", "orders:write")');
    expect(result.code).toContain("requireAuthenticated");
    // The first-class guard-array form: withGuards in `before: [...]` is
    // statically extracted too (the RBAC optimization for before chains).
    expect(result.code).toContain('can("invoices:read", "invoices:write")');

    // Guard consts are wired into the route hook var (pre-execution chain).
    // The array also spreads the wrapper-attached runtime config first
    // (`handler.config.before`) — the boilerplate mechanism.
    expect(result.code).toMatch(/__guard__h\d+_\d+/);
    expect(result.code).toContain("...(handler__h2?.config?.before ?? [])");
    expect(result.code).toContain("...(handler__h2?.config?.after ?? [])");
    // The route-after stage (route-local after hooks) is emitted in the core fn.
    expect(result.code).toContain('runTimed("route.after"');

    // The guard symbols are imported from `@ignex/core`.
    const coreImport = result.code.match(/import \{([\s\S]*?)\} from "@ignex\/core";/)?.[1];
    expect(coreImport).toBeDefined();
    expect(coreImport).toContain("requireAuthenticated");
    expect(coreImport).toContain("hasRole");
    expect(coreImport).toContain("can");
    expect(coreImport).toContain("canAll");
  });

  it("guarded routes are not constant-hoisted (guards must run)", async () => {
    // The guarded handlers return constant JSON — without guards the compiler
    // would hoist them to frozen bodies. Guards force the normal path.
    const layout = materializeFixture("guards");
    const result = await buildAsync(baseOptions(layout));
    expect(result.code).toContain("__guard_");
    // No frozen constant body for the guarded routes (they are not hoisted).
    expect(result.code).not.toContain("__finalize({ body:");
  });

  it("a before-guarded constant body is never hoisted (guard would be bypassed)", async () => {
    // hoist-before.get.ts returns a literal — WITHOUT the before array the
    // compiler hoists it to a frozen body. The guard array must prevent that
    // AND still statically emit the guard.
    const layout = materializeFixture("guards");
    const result = await buildAsync(baseOptions(layout));
    expect(result.code).toContain('can("hoist:read")');
    // The hoisted form uses a frozen body const — absent for the route.
    expect(result.code).not.toContain("Object.freeze({ ok: true })");
    expect(result.code).not.toContain("__finalize({ body:");
  });

  it("an after-only route emits the route.after stage on the full-context path", async () => {
    const layout = materializeFixture("guards");
    const result = await buildAsync(baseOptions(layout));
    expect(result.code).toContain('runTimed("route.after"');
    expect(result.code).toContain("handler__h4?.config?.after");
  });

  it("without withGuards the output has no guard emission", async () => {
    const layout = materializeFixture("named-export");
    const result = await buildAsync(baseOptions(layout));
    expect(result.code).not.toContain("__guard_");
    expect(result.code).not.toContain("hasRole(");
    expect(result.code).not.toContain("canAll(");
  });
});
