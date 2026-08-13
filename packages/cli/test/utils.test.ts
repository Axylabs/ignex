import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCliArgs, resolveRoot } from "../src/utils/args.js";
import { CONFIG_FILES, loadConfig } from "../src/utils/config.js";
import { formatError } from "../src/utils/logger.js";

describe("parseCliArgs", () => {
  const options = { root: { type: "string" }, watch: { type: "boolean" } };

  it("parses string and boolean flags", () => {
    const { values } = parseCliArgs(["--root", "/tmp/x", "--watch"], options);
    expect(values.root).toBe("/tmp/x");
    expect(values.watch).toBe(true);
  });

  it("collects positionals", () => {
    const { positionals } = parseCliArgs(["my-app"], options);
    expect(positionals).toEqual(["my-app"]);
  });

  it("collects unknown flags as boolean true and the value as a positional", () => {
    const { values, positionals } = parseCliArgs(["--nope", "x"], options);
    expect(values.nope).toBe(true);
    expect(positionals).toEqual(["x"]);
  });

  it("maps negated booleans to the literal no-* key (Bun parseArgs behavior)", () => {
    const { values } = parseCliArgs(["--no-watch"], options);
    expect((values as Record<string, unknown>)["no-watch"]).toBe(true);
    expect(values.watch).toBeUndefined();
  });
});

describe("resolveRoot", () => {
  it("prefers --root, then positional, then cwd", () => {
    expect(resolveRoot({ root: "/a" }, ["/b"])).toBe("/a");
    expect(resolveRoot({}, ["/b"])).toBe("/b");
    expect(resolveRoot({}, [])).toBe(process.cwd());
  });

  it("resolves relative roots to absolute", () => {
    expect(resolveRoot({}, ["subdir"]).startsWith("/")).toBe(true);
  });
});

describe("CONFIG_FILES", () => {
  it("includes ignex.config.json", () => {
    expect(CONFIG_FILES).toContain("ignex.config.json");
    expect(CONFIG_FILES).toContain("ignex.config.ts");
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ignex-cli-config-"));
    writeFileSync(
      join(dir, "ignex.config.json"),
      JSON.stringify({ routesDir: "app/routes", outDir: "build" }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses ignex.config.json", async () => {
    const config = await loadConfig(dir);
    expect(config.routesDir).toBe("app/routes");
    expect(config.outDir).toBe("build");
  });

  it("returns an empty object when no config exists", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ignex-cli-empty-"));
    try {
      const config = await loadConfig(empty);
      expect(config).toEqual({});
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("formatError", () => {
  it("uses Error.message for Error instances", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(formatError("boom")).toBe("boom");
    expect(formatError(42)).toBe("42");
    expect(formatError(undefined)).toBe("undefined");
  });
});
