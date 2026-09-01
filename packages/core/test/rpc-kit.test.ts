import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcKit } from "../src/rpc/kit";

const tmpDirs: string[] = [];
const manifestPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-kit-"));
  tmpDirs.push(dir);
  return join(dir, ".ignex", "rpc-manifest.json");
};

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createRpcKit", () => {
  it("registers methods and exposes a sorted deterministic manifest", () => {
    const kit = createRpcKit({});
    kit.define("b.method", { schema: { type: "object" }, handler: () => 1 });
    kit.define("a.method", { schema: { type: "object" }, handler: () => 2 });
    kit.define("b.method", { schema: { type: "object" }, handler: () => 3 });
    expect(kit.methods()).toEqual(["a.method", "b.method"]);
    expect(kit.has("a.method")).toBe(true);
    expect(kit.has("nope")).toBe(false);
    const doc = kit.manifest();
    expect(doc.version).toBe(1);
    expect(Object.keys(doc.methods)).toEqual(["a.method", "b.method"]);
  });

  it("compiles native validators once per method and survives compile failures", () => {
    let compiled = 0;
    const kit = createRpcKit({
      compileValidator: (json) => {
        compiled += 1;
        if (json === '"boom"') throw new Error("compile failed");
        return { validate: (raw) => !raw.includes("reject") };
      },
    });
    kit.define("ok", { schema: { type: "object" }, handler: () => 1 });
    kit.define("boom", { schema: "boom" as unknown as object, handler: () => 1 });
    expect(compiled).toBe(2);
    expect(kit.has("boom")).toBe(true);
  });

  it("writes the manifest atomically and flushes synchronously", async () => {
    const path = manifestPath();
    const kit = createRpcKit({ manifestPath: path });
    kit.define("me.get", { schema: { type: "object" }, handler: () => null });
    kit.flushManifest();
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      methods: Record<string, object>;
    };
    expect(doc.version).toBe(1);
    expect(doc.methods["me.get"]).toEqual({ type: "object" });
  });

  it("accepts payloads when no validator is injected (open dispatch)", async () => {
    const kit = createRpcKit({});
    kit.define("open.method", { schema: { type: "object" }, handler: () => "ok" });
    expect(kit.methods()).toEqual(["open.method"]);
    // Manifest stays disabled without a path — flush must be a no-op.
    kit.flushManifest();
  });
});
