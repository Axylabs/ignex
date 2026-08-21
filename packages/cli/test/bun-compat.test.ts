import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bunWriteFile, commandExistsBun, secureRandomBytes } from "../src/utils/bun-compat.js";

describe("secureRandomBytes", () => {
  it("returns the requested number of bytes", () => {
    expect(secureRandomBytes(16).byteLength).toBe(16);
    expect(secureRandomBytes(0).byteLength).toBe(0);
  });

  it("produces distinct values across calls (CSPRNG)", () => {
    const a = secureRandomBytes(32).toString("hex");
    const b = secureRandomBytes(32).toString("hex");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("bunWriteFile", () => {
  it("writes utf8 content to disk (Bun.write under Bun, node otherwise)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-cli-bun-compat-"));
    try {
      const file = join(dir, "out.txt");
      await bunWriteFile(file, "hello ignex");
      expect(readFileSync(file, "utf8")).toBe("hello ignex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("commandExistsBun", () => {
  it("returns false for unknown commands", () => {
    expect(commandExistsBun("definitely-not-a-real-command-12345")).toBe(false);
  });

  it("detects real binaries on PATH", () => {
    // `node` must exist to run the test toolchain (Bun path when under Bun).
    expect(commandExistsBun("node")).toBe(true);
  });
});
