import { describe, expect, it } from "vitest";
import { isValidPort, normalizeOutDir, shouldIgnore } from "../src/utils/dev.js";

const ROOT = "/repo/my-app";

describe("shouldIgnore", () => {
  it("ignores node_modules", () => {
    expect(shouldIgnore("node_modules/x/index.js", ".ignus", ROOT)).toBe(true);
    expect(shouldIgnore("/repo/my-app/node_modules/x.js", ".ignus", ROOT)).toBe(true);
  });

  it("ignores .git", () => {
    expect(shouldIgnore(".git/config", ".ignus", ROOT)).toBe(true);
    expect(shouldIgnore("/repo/my-app/.git/HEAD", ".ignus", ROOT)).toBe(true);
  });

  it("ignores the compiler output directory (relative outDir)", () => {
    expect(shouldIgnore(".ignus/server.js", ".ignus", ROOT)).toBe(true);
    expect(shouldIgnore(".ignus/validators/x.cjs", ".ignus", ROOT)).toBe(true);
  });

  it("ignores an absolute outDir inside the root", () => {
    expect(shouldIgnore(".ignus/server.js", "/repo/my-app/.ignus", ROOT)).toBe(true);
    expect(shouldIgnore("/repo/my-app/.ignus/server.js", "/repo/my-app/.ignus", ROOT)).toBe(true);
  });

  it("ignores files inside a ../ outDir resolved against root", () => {
    expect(shouldIgnore("/repo/out/server.js", "../out", ROOT)).toBe(true);
  });

  it("ignores dist, logs, lockfiles and the incremental cache", () => {
    expect(shouldIgnore("dist/__server.js", ".ignus", ROOT)).toBe(true);
    expect(shouldIgnore("server.log", ".ignus", ROOT)).toBe(true);
    expect(shouldIgnore("bun.lockb", ".ignus", ROOT)).toBe(true);
    expect(shouldIgnore("package-lock.json", ".ignus", ROOT)).toBe(true);
    expect(shouldIgnore(".ignus-cache.json", ".ignus", ROOT)).toBe(true);
  });

  it("does not ignore route/source files", () => {
    expect(shouldIgnore("src/routes/health.get.ts", ".ignus", ROOT)).toBe(false);
    expect(shouldIgnore("src/app.config.ts", ".ignus", ROOT)).toBe(false);
  });
});

describe("normalizeOutDir", () => {
  it("resolves relative outDir against root and strips trailing slashes", () => {
    expect(normalizeOutDir(".ignus", ROOT)).toBe("/repo/my-app/.ignus");
    expect(normalizeOutDir("./.ignus/", ROOT)).toBe("/repo/my-app/.ignus");
  });

  it("keeps absolute outDir", () => {
    expect(normalizeOutDir("/tmp/build", ROOT)).toBe("/tmp/build");
  });

  it("resolves .. relative outDir", () => {
    expect(normalizeOutDir("../out", ROOT)).toBe("/repo/out");
  });
});

describe("isValidPort", () => {
  it("accepts valid ports", () => {
    expect(isValidPort("3000")).toBe(true);
    expect(isValidPort("1")).toBe(true);
    expect(isValidPort("65535")).toBe(true);
  });

  it("rejects invalid ports", () => {
    expect(isValidPort("0")).toBe(false);
    expect(isValidPort("65536")).toBe(false);
    expect(isValidPort("abc")).toBe(false);
    expect(isValidPort("-1")).toBe(false);
    expect(isValidPort("")).toBe(false);
    expect(isValidPort("3.5")).toBe(false);
  });
});
