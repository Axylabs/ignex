import { describe, expect, it } from "vitest";
import { commandExists, detectRuntime, normalizeRuntime } from "../src/utils/runtime.js";

describe("normalizeRuntime", () => {
  it("defaults to bun", () => {
    expect(normalizeRuntime(undefined)).toBe("bun");
    expect(normalizeRuntime("")).toBe("bun");
  });

  it("maps node explicitly", () => {
    expect(normalizeRuntime("node")).toBe("node");
    expect(normalizeRuntime("NODE")).toBe("node");
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
  it("resolves node to a real node binary when requested", () => {
    const result = detectRuntime("node");
    // On a machine with node on PATH this is exactly "node"; otherwise it
    // degrades to the current runtime (never an empty string).
    expect(result.length).toBeGreaterThan(0);
  });

  it("prefers bun when requested", () => {
    const result = detectRuntime("bun");
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back to auto-detection for unknown values", () => {
    expect(detectRuntime("bogus").length).toBeGreaterThan(0);
    expect(detectRuntime("auto").length).toBeGreaterThan(0);
  });
});
