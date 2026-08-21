import { describe, expect, it } from "vitest";
import { commandExists, detectRuntime, normalizeRuntime } from "../src/utils/runtime.js";

describe("normalizeRuntime", () => {
  it("defaults to bun", () => {
    expect(normalizeRuntime(undefined)).toBe("bun");
    expect(normalizeRuntime("")).toBe("bun");
  });

  it("normalizes node to bun (node is not a supported runtime)", () => {
    // The generated server requires Bun — a `--runtime node` request must not
    // scaffold a server that cannot boot.
    expect(normalizeRuntime("node")).toBe("bun");
    expect(normalizeRuntime("NODE")).toBe("bun");
  });
});

describe("commandExists", () => {
  it("returns false for unknown commands", () => {
    expect(commandExists("definitely-not-a-real-command-12345")).toBe(false);
  });

  it("detects real binaries on PATH", () => {
    // `node` must exist to run the test toolchain.
    expect(commandExists("node")).toBe(true);
  });
});

describe("detectRuntime", () => {
  it("always resolves to bun (node is not a supported runtime)", () => {
    // Tests run under Bun, so the only runtime resolves to "bun".
    expect(detectRuntime("node")).toBe("bun");
    expect(detectRuntime("bun")).toBe("bun");
  });

  it("falls back to auto-detection for unknown values", () => {
    expect(detectRuntime("bogus")).toBe("bun");
    expect(detectRuntime("auto")).toBe("bun");
  });
});
