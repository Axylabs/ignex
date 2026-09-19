/**
 * Plugin-declared members on the usage-specialized tier — regression test.
 *
 * The specialized object-literal context used to emit ONLY the members the
 * route handler referenced. A declarable plugin layer (`INTERNAL_PLUGIN_USAGE`,
 * e.g. `cors`/`security`) ran its hooks against that literal, so a lean route
 * reading only `ctx.json` handed `cors.onRequest` a ctx with NO `headers` /
 * `method` members — `TypeError: ctx.headers is undefined` → 500 on every
 * request to an otherwise-lean app.
 *
 * This pins the fix: the emitted ctx is the ROUTE ∪ PLUGIN-LAYER usage union,
 * so plugin hooks always see exactly the members they declared.
 *
 * Two layers of proof (same convention as `abort-port.test.ts`):
 *  - a structural test (always runs under vitest) that the specialized literal
 *    carries the plugin-declared members, and
 *  - a behavioral test that boots the compiled artifact and serves a real
 *    request through the plugin chain (needs plain Bun; skipped under Node
 *    vitest workers).
 */
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { fixturePath, materializeFixture } from "./helpers";

const origPort = process.env.PORT;
const origHttps = process.env.IGNEX_HTTPS;
afterEach(() => {
  if (origPort === undefined) delete process.env.PORT;
  else process.env.PORT = origPort;
  if (origHttps === undefined) delete process.env.IGNEX_HTTPS;
  else process.env.IGNEX_HTTPS = origHttps;
});

/** Build the `plugins-specialize` fixture (cors + security, ctx.json-only route). */
const build = async () => {
  const layout = materializeFixture("plugins-specialize");
  const result = await buildAsync({
    routesDir: layout.routesDir,
    outDir: layout.outDir,
    outFile: "server.js",
    appConfig: fixturePath("plugins-specialize", "app.config.ts"),
    minify: false,
    sourceMap: false,
    incremental: false,
    generateTypes: false,
    generateOpenAPI: false,
    generateClient: false,
  });
  return { layout, result };
};

describe("plugin-declared members on the specialized tier", () => {
  it("emits the plugin layer's members into the lean route's context literal", async () => {
    const { result } = await build();
    expect(result.errors).toHaveLength(0);

    // The route stays on the usage-specialized tier — the full-context route
    // emission is a bare `ctx = createContext(...)` assignment (`const ctx = …`
    // only appears in the runtime's generic `__wrap` variants, which are
    // emitted for every build regardless of tier).
    expect(result.code).not.toMatch(/^\s*ctx = createContext\(/m);

    // …but the emitted literal now carries cors's `headers`/`method` and
    // security's `headers`/`req` alongside the route's own `json`. Before the
    // merge it was `ctx = { json: … }` and `cors.onRequest` crashed.
    const literal = result.code.match(/ctx = \{ [^}]*\};/)?.[0] ?? "";
    expect(literal).toContain("headers: req.headers");
    expect(literal).toContain("method: req.method");
    expect(literal).toContain("json:");
    // `req` is emitted as its own member (`req: <req>`) so the hooks' reads of
    // `ctx.req.url` / `ctx.req.headers` resolve; `headers:`/`method:` reference
    // it too.
    expect(literal).toMatch(/,\s*req\s*(?:,|:)/);
  });

  const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

  it.runIf(hasBun)("serves a real request through the plugin chain (no TypeError)", async () => {
    const { layout, result } = await build();
    expect(result.errors).toHaveLength(0);

    // Re-point the `@ignex/core` link defensively (some checkouts hoist core
    // under the compiler package instead of the repo root).
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
      // already resolve; the failure below is still meaningful.
    }

    process.env.PORT = String(34100 + Math.floor(Math.random() * 400));
    process.env.IGNEX_HTTPS = "0";
    const serverPath = join(layout.outDir, "plugin-lean-server.js");
    writeFileSync(serverPath, `${result.code}\nexport { __routes };\n`);

    const mod = (await import(serverPath)) as {
      default: { stop(drain?: boolean): void };
      __routes: Record<string, { GET?: (req: Request) => Response | Promise<Response> }>;
    };
    try {
      const get = mod.__routes["/hello"]?.GET;
      if (!get) throw new Error("compiled route /hello GET handler missing");

      // The regression: a lean route behind cors+security used to 500 because
      // cors.onRequest read `ctx.headers` (undefined on the specialized ctx).
      const noOrigin = await get(new Request("http://localhost/hello"));
      expect(noOrigin.status).toBe(200);
      await expect(noOrigin.json()).resolves.toEqual({ ok: true });

      // cors must see headers/method: an Origin'd request gets the CORS
      // decoration (onRequest + onResponse both read the declared members).
      const withOrigin = await get(
        new Request("http://localhost/hello", {
          headers: { origin: "https://example.com" },
        }),
      );
      expect(withOrigin.status).toBe(200);
      expect(withOrigin.headers.get("access-control-allow-origin")).toBe("https://example.com");
      // security's onResponse also ran — its declared `headers`/`req` present.
      expect(withOrigin.headers.get("content-security-policy")).toBe("default-src 'self'");
    } finally {
      mod.default.stop();
    }
  });
});
