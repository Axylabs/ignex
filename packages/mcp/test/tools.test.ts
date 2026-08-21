/**
 * MCP tool hardening tests (2026-08-19).
 *
 * - `route` never throws into the protocol on ordinary input (empty input /
 *   path traversal / bad method) — returns `{ ok: false }` instead.
 * - `list-routes` enumerates route files without building.
 * - `doctor`'s compiler check is a real probe.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDoctorTool, runListRoutesTool, runRouteTool } from "../src/tools.js";

describe("route tool fails gracefully", () => {
  it("returns { ok:false } for an empty input (no protocol throw)", async () => {
    const result = await runRouteTool({ root: undefined, input: "", method: undefined });
    const parsed = JSON.parse(result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Invalid route input/i);
  });

  it("returns { ok:false } for path traversal", async () => {
    const result = await runRouteTool({
      root: undefined,
      input: "../evil.get",
      method: undefined,
    });
    const parsed = JSON.parse(result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
  });

  it("returns { ok:false } for an invalid method", async () => {
    const result = await runRouteTool({
      root: undefined,
      input: "thing",
      method: "frobnicate",
    });
    const parsed = JSON.parse(result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
  });
});

describe("list-routes tool", () => {
  const dir = join(tmpdir(), `ignex-mcp-list-${Date.now()}`);
  beforeAll(() => {
    mkdirSync(join(dir, "src/routes/api"), { recursive: true });
    writeFileSync(join(dir, "src/routes/index.get.ts"), "export default () => 1;");
    writeFileSync(join(dir, "src/routes/api/orders.post.ts"), "export default () => 1;");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("enumerates route files under src/routes", async () => {
    const result = await runListRoutesTool({ root: dir });
    const parsed = JSON.parse(result) as { ok: boolean; files?: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(["api/orders.post.ts", "index.get.ts"]);
  });

  it("reports { ok:false } when there is no routes dir", async () => {
    const empty = join(tmpdir(), `ignex-mcp-empty-${Date.now()}`);
    const result = await runListRoutesTool({ root: empty });
    const parsed = JSON.parse(result) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });
});

describe("doctor tool", () => {
  it("reports a real compiler probe", async () => {
    const result = await runDoctorTool();
    const parsed = JSON.parse(result) as { checks: Array<{ name: string; ok: boolean }> };
    const compiler = parsed.checks.find((c) => c.name === "compiler");
    expect(compiler?.ok).toBe(true);
  });
});
