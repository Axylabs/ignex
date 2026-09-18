/**
 * @fileoverview AOT abort short-circuit — the compiled counterpart of
 * `packages/core/test/abort-port.test.ts`.
 *
 * The interpreted lifecycle short-circuits a request that is ALREADY aborted
 * before the pipeline runs (empty 200, no hooks, no handler). The generated
 * route core fn must do the same, at its very top and before context creation,
 * so a disconnected client never pays the pipeline.
 *
 * Two layers of proof:
 *  - a structural test (always runs under vitest) that the guard is emitted
 *    before the context prelude, and
 *  - a behavioral test that boots the compiled artifact and invokes its real
 *    route wrapper with a pre-aborted `Request` (needs plain Bun for
 *    `Bun.serve`; skipped under Node vitest workers — the same `runIf(hasBun)`
 *    convention as `pattern-middleware.test.ts`). `scripts/verify-aot-abort.ts`
 *    is the always-Bun executable check.
 */
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { materializeFixture } from "./helpers";

const origPort = process.env.PORT;
const origHttps = process.env.IGNEX_HTTPS;
afterEach(() => {
  if (origPort === undefined) delete process.env.PORT;
  else process.env.PORT = origPort;
  if (origHttps === undefined) delete process.env.IGNEX_HTTPS;
  else process.env.IGNEX_HTTPS = origHttps;
});

/** A signal that is already aborted before it reaches the server. */
const preAborted = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

/** Build the `abort` fixture with the standard test options. */
const build = async () => {
  const layout = materializeFixture("abort");
  const result = await buildAsync({
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
  });
  return { layout, result };
};

describe("compiled abort short-circuit", () => {
  it("emits the guard as the first statement of the core fn", async () => {
    const { result } = await build();
    expect(result.errors).toHaveLength(0);

    expect(result.code).toMatch(
      /const __abortedResponse = (?:\/\* @__PURE__ \*\/ )?abortedResponse\(\);/,
    );
    expect(result.code).toContain("if (req.signal.aborted) return __abortedResponse;");
    // The guard is the FIRST statement of the core fn — before `let ctx`, the
    // pre-handler stages, and the handler.
    expect(result.code).toMatch(
      /function \w+\(req, params, server\) \{\n {2}if \(req\.signal\.aborted\) return __abortedResponse;\n {2}let ctx;/,
    );
  });

  // Booting the artifact needs plain Bun (`Bun.serve` + dynamic import of the
  // generated module); vitest workers may run under Node.
  const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

  it.runIf(hasBun)("pre-aborted request → empty 200, handler never called", async () => {
    const { layout, result } = await build();
    expect(result.errors).toHaveLength(0);

    // `materializeFixture` links `node_modules/@ignex/core`; the linker needs a
    // resolvable target when it bundles. Some checkouts hoist core under the
    // compiler package instead of the repo root — re-point defensively.
    const coreLink = join(layout.outDir, "node_modules", "@ignex", "core");
    const corePkg = fileURLToPath(new URL("../node_modules/@ignex/core", import.meta.url));
    try {
      unlinkSync(coreLink);
    } catch {
      // no existing link — nothing to replace
    }
    mkdirSync(join(layout.outDir, "node_modules", "@ignex"), { recursive: true });
    try {
      symlinkSync(corePkg, coreLink, "dir");
    } catch {
      // symlinks may be unavailable in a sandbox — the build's own link may
      // already resolve; the guard failure below is still meaningful.
    }

    process.env.PORT = String(34100 + Math.floor(Math.random() * 400));
    process.env.IGNEX_HTTPS = "0";
    const serverPath = join(layout.outDir, "abort-server.js");
    writeFileSync(serverPath, `${result.code}\nexport { __routes };\n`);

    const globals = globalThis as { __abortHandlerCalled?: boolean };
    delete globals.__abortHandlerCalled;

    const mod = (await import(serverPath)) as {
      default: { stop(drain?: boolean): void };
      __routes: Record<string, { GET?: (req: Request) => Response | Promise<Response> }>;
    };
    try {
      const get = mod.__routes["/ping"]?.GET;
      if (!get) throw new Error("compiled route /ping GET handler missing");

      const aborted = await get(new Request("http://localhost/ping", { signal: preAborted() }));
      expect(aborted.status).toBe(200);
      await expect(aborted.text()).resolves.toBe("");
      expect(globals.__abortHandlerCalled).toBeUndefined();

      // Sanity: a live request DOES reach the handler — the guard is the only
      // reason the aborted one skipped work.
      const live = await get(new Request("http://localhost/ping"));
      expect(live.status).toBe(200);
      await expect(live.json()).resolves.toEqual({ ok: true });
      expect(globals.__abortHandlerCalled).toBe(true);
    } finally {
      mod.default.stop();
    }
  });
});
