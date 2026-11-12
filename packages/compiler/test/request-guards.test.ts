import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAsync, type CompileResult } from "../src/index";
import { type FixtureLayout, materializeFixture, minimalOptions } from "./helpers";

const hasBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const originalPort = process.env.PORT;
const originalHttps = process.env.IGNEX_HTTPS;

afterEach(() => {
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalHttps === undefined) delete process.env.IGNEX_HTTPS;
  else process.env.IGNEX_HTTPS = originalHttps;
});

const build = (_extra: Parameters<typeof minimalOptions>[1]) =>
  materializeFixture("request-guards");

type Routes = Record<string, Record<string, (req: Request) => Response | Promise<Response>>>;

const loadRoutes = async (
  layout: FixtureLayout,
  result: CompileResult,
): Promise<{ routes: Routes; stop: () => void }> => {
  process.env.PORT = String(34300 + Math.floor(Math.random() * 400));
  process.env.IGNEX_HTTPS = "0";
  const serverPath = join(layout.outDir, "guard-server.js");
  writeFileSync(serverPath, `${result.code}\nexport { __routes };\n`);
  const mod = (await import(serverPath)) as {
    default: { stop(): void };
    __routes: Routes;
  };
  return { routes: mod.__routes, stop: () => mod.default.stop() };
};

describe("compiled request guards", () => {
  it("passes handlerTimeoutMs through validation into a working generated timeout", async () => {
    const layout = await build({ handlerTimeoutMs: 20 });
    const result = await buildAsync(minimalOptions(layout, { handlerTimeoutMs: 20 }));
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain(
      "const __HANDLER_TIMEOUT_MS = __serverCfg.handlerTimeoutMs ?? 20;",
    );

    if (!hasBun) return;
    const { routes, stop } = await loadRoutes(layout, result);
    try {
      const handler = routes["/slow"]?.GET;
      expect(handler).toBeDefined();
      const response = await handler?.(new Request("http://localhost/slow"));
      expect(response?.status).toBe(503);
      expect(response?.headers.get("x-ignex-reason")).toBe("handler-timeout");
      await expect(response?.json()).resolves.toMatchObject({ code: "IGN_HANDLER_TIMEOUT" });
    } finally {
      stop();
    }
  });

  it("enforces maxHeaderBytes on a constant-eligible route and on fallbacks", async () => {
    const layout = await build({ maxHeaderBytes: 128 });
    const result = await buildAsync(minimalOptions(layout, { maxHeaderBytes: 128 }));
    expect(result.errors).toHaveLength(0);
    expect(result.code).toContain("const __MAX_HEADER_BYTES = 128;");
    expect(result.code).not.toContain("STATIC_RES_GET_constant");

    if (!hasBun) return;
    const { routes, stop } = await loadRoutes(layout, result);
    try {
      const handler = routes["/constant"]?.GET;
      expect(handler).toBeDefined();
      const small = await handler?.(new Request("http://localhost/constant"));
      expect(small?.status).toBe(200);
      await expect(small?.text()).resolves.toBe('"constant"');

      const oversized = await handler?.(
        new Request("http://localhost/constant", { headers: { "x-bomb": "a".repeat(256) } }),
      );
      expect(oversized?.status).toBe(431);
      await expect(oversized?.json()).resolves.toMatchObject({ code: "HEADER_TOO_LARGE" });
    } finally {
      stop();
    }
  });
});
