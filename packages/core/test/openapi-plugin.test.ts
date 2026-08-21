/**
 * Tests for the `openapi()` plugin — runtime OpenAPI docs + Scalar/Swagger UI.
 *
 * Interpreted mode (`createApp({ router, plugins: [openapi()] })`) registers
 * real spec/docs routes and enumerates the router; AOT mode (the `onRequest`
 * fallback, when no router exists) intercepts the two paths and serves the
 * compiled artifact (falling back to an empty document).
 */

import { describe, expect, it } from "vitest";
import { createApp, createRouter, openapi } from "../src/index.js";
import { inject } from "./helpers/inject";

describe("openapi() — interpreted mode (createApp + router)", () => {
  it("serves a spec with real paths and excludes its own endpoints", async () => {
    const app = createApp({
      router: createRouter()
        .get("/health", () => "ok")
        .get("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }), {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        }),
      plugins: [openapi({ documentation: { title: "Test API", version: "1.0.0" } })],
    });

    const res = await inject(app, { url: "/openapi.json" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const spec = (await res.json()) as {
      info?: { title?: string; version?: string };
      paths?: Record<string, unknown>;
    };
    expect(spec.info?.title).toBe("Test API");
    expect(spec.paths).toHaveProperty("/health");
    expect(spec.paths).toHaveProperty("/users/{id}");
    // The plugin's own endpoints must not appear in the document.
    expect(spec.paths).not.toHaveProperty("/openapi.json");
    expect(spec.paths).not.toHaveProperty("/openapi");
  });

  it("serves the Scalar docs UI at the default path", async () => {
    const app = createApp({
      router: createRouter().get("/health", () => "ok"),
      plugins: [openapi()],
    });
    const res = await inject(app, { url: "/openapi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("api-reference");
  });

  it("serves a docs Content-Security-Policy that allows the CDN bundles", async () => {
    const app = createApp({
      router: createRouter().get("/health", () => "ok"),
      plugins: [openapi()],
    });
    const res = await inject(app, { url: "/openapi" });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("https://unpkg.com");
  });

  it("respects per-route detail.hide and exclude.paths", async () => {
    const app = createApp({
      router: createRouter()
        .get("/public", () => "ok")
        .get("/secret", () => "ok", { detail: { hide: true } })
        .get("/skipme", () => "ok"),
      plugins: [openapi({ exclude: { paths: ["/skipme"] } })],
    });
    const res = await inject(app, { url: "/openapi.json" });
    const spec = (await res.json()) as { paths?: Record<string, unknown> };
    expect(spec.paths).toHaveProperty("/public");
    expect(spec.paths).not.toHaveProperty("/secret");
    expect(spec.paths).not.toHaveProperty("/skipme");
  });

  it("honors custom specPath/path and provider null (spec-only)", async () => {
    const app = createApp({
      router: createRouter().get("/health", () => "ok"),
      plugins: [openapi({ specPath: "/docs.json", path: "/docs", provider: null })],
    });
    expect((await inject(app, { url: "/docs.json" })).status).toBe(200);
    // provider: null → no UI page is registered.
    expect((await inject(app, { url: "/docs" })).status).toBe(404);
  });
});

describe("openapi() — AOT fallback (onRequest interception, no router)", () => {
  const plugin = openapi();

  const run = async (path: string): Promise<Response | object> => {
    const result = plugin.onRequest?.({ url: new URL(`http://localhost${path}`) } as never);
    return (await result) as Response | object;
  };

  it("serves the docs UI at /openapi", async () => {
    const res = await run("/openapi");
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("api-reference");
  });

  it("passes non-matching paths through unchanged", async () => {
    const ctx = { url: new URL("http://localhost/health") } as never;
    const out = await plugin.onRequest?.(ctx);
    expect(out).toBe(ctx);
  });

  it("serves a JSON document at /openapi.json (empty without an artifact)", async () => {
    const res = await run("/openapi.json");
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toHaveProperty("paths");
  });

  it("serves the NEWEST artifact across candidates (dev regeneration beats stale dist)", async () => {
    const { mkdtempSync, mkdirSync, utimesSync, writeFileSync, readFileSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ignex-openapi-"));

    const stale = join(dir, "dist", "openapi.json");
    const fresh = join(dir, ".ignex", "openapi.json");
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, ".ignex"), { recursive: true });

    const doc = (routes: string[]): string =>
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "T", version: "1.0.0" },
        paths: Object.fromEntries(routes.map((p) => [p, { get: { responses: {} } }])),
      });

    // Both exist; `stale` is older (mtime in the past).
    writeFileSync(stale, doc(["/old"]));
    writeFileSync(fresh, doc(["/fresh"]));
    const now = Date.now() / 1000;
    utimesSync(stale, now - 60, now - 60);
    utimesSync(fresh, now, now);

    // The AOT artifact reader is Bun-gated; vitest runs under Node workers, so
    // provide a minimal `Bun.file` shim backed by the real fs.
    const realBun = (globalThis as { Bun?: unknown }).Bun;
    const stat = (path: string): { mtimeMs: number } => {
      const { statSync } = require("node:fs") as typeof import("node:fs");
      return statSync(path);
    };
    (globalThis as { Bun?: unknown }).Bun = {
      file: (path: string) => ({
        exists: async () => {
          const { existsSync } = require("node:fs") as typeof import("node:fs");
          return existsSync(path);
        },
        get lastModified() {
          return stat(path).mtimeMs;
        },
        json: async () => JSON.parse(readFileSync(path, "utf-8")) as unknown,
      }),
    };
    try {
      const plugin = openapi({ artifactPath: [fresh, stale] });
      const ctx = { url: new URL("http://localhost/openapi.json") } as never;
      const res = (await plugin.onRequest?.(ctx)) as Response;
      const spec = (await res.json()) as { paths?: Record<string, unknown> };
      expect(spec.paths).toHaveProperty("/fresh");
      expect(spec.paths).not.toHaveProperty("/old");

      // Regenerating the fresh file (newer mtime) is picked up without a restart.
      writeFileSync(fresh, doc(["/fresh", "/new-route"]));
      utimesSync(fresh, now + 1, now + 1);
      const res2 = (await plugin.onRequest?.(ctx)) as Response;
      const spec2 = (await res2.json()) as { paths?: Record<string, unknown> };
      expect(spec2.paths).toHaveProperty("/new-route");
    } finally {
      (globalThis as { Bun?: unknown }).Bun = realBun;
    }
  });
});
