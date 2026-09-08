import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isValidPort, normalizeOutDir, shouldIgnore } from "../src/utils/dev.js";

/**
 * Platform-appropriate absolute project root. These helpers delegate to
 * `node:path`, so a bare POSIX root (`/repo/my-app`) is meaningless on Windows
 * (root-relative paths resolve against the current drive). Deriving ROOT from
 * `resolve` keeps every assertion valid on POSIX and Windows alike.
 */
const ROOT = resolve("/repo/my-app");
/** Slash-normalize a `node:path` result (backslashes on Windows) — the form the helpers emit. */
const norm = (p: string): string => p.replaceAll("\\", "/");

describe("shouldIgnore", () => {
  it("ignores node_modules", () => {
    expect(shouldIgnore("node_modules/x/index.js", ".ignex", ROOT)).toBe(true);
    expect(shouldIgnore("/repo/my-app/node_modules/x.js", ".ignex", ROOT)).toBe(true);
  });

  it("ignores .git", () => {
    expect(shouldIgnore(".git/config", ".ignex", ROOT)).toBe(true);
    expect(shouldIgnore("/repo/my-app/.git/HEAD", ".ignex", ROOT)).toBe(true);
  });

  it("ignores the compiler output directory (relative outDir)", () => {
    expect(shouldIgnore(".ignex/server.js", ".ignex", ROOT)).toBe(true);
    expect(shouldIgnore(".ignex/validators/x.cjs", ".ignex", ROOT)).toBe(true);
  });

  it("ignores an absolute outDir inside the root", () => {
    const out = resolve(ROOT, ".ignex");
    // Relative filename (recursive watch reports paths relative to root).
    expect(shouldIgnore(".ignex/server.js", out, ROOT)).toBe(true);
    // Absolute file path inside the outDir.
    expect(shouldIgnore(resolve(out, "server.js"), out, ROOT)).toBe(true);
  });

  it("ignores files inside a ../ outDir resolved against root", () => {
    const out = resolve(ROOT, "..", "out");
    expect(shouldIgnore(resolve(out, "server.js"), "../out", ROOT)).toBe(true);
  });

  it("ignores dist, logs, lockfiles and the incremental cache", () => {
    expect(shouldIgnore("dist/__server.js", ".ignex", ROOT)).toBe(true);
    expect(shouldIgnore("server.log", ".ignex", ROOT)).toBe(true);
    expect(shouldIgnore("bun.lockb", ".ignex", ROOT)).toBe(true);
    expect(shouldIgnore("package-lock.json", ".ignex", ROOT)).toBe(true);
    expect(shouldIgnore(".ignex-cache.json", ".ignex", ROOT)).toBe(true);
  });

  it("does not ignore route/source files", () => {
    expect(shouldIgnore("src/routes/health.get.ts", ".ignex", ROOT)).toBe(false);
    expect(shouldIgnore("src/app.config.ts", ".ignex", ROOT)).toBe(false);
  });
});

describe("normalizeOutDir", () => {
  it("resolves relative outDir against root and strips trailing slashes", () => {
    const expected = norm(resolve(ROOT, ".ignex"));
    expect(normalizeOutDir(".ignex", ROOT)).toBe(expected);
    expect(normalizeOutDir("./.ignex/", ROOT)).toBe(expected);
    expect(normalizeOutDir(".ignex//", ROOT)).toBe(expected);
  });

  it("keeps an absolute outDir unchanged", () => {
    const abs = resolve("/tmp/build");
    expect(normalizeOutDir(abs, ROOT)).toBe(norm(abs));
  });

  it("resolves .. relative outDir", () => {
    expect(normalizeOutDir("../out", ROOT)).toBe(norm(resolve(ROOT, "../out")));
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
