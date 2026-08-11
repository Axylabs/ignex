import { describe, expect, it, vi } from "vitest";
import { DiagnosticCodes, DiagnosticCollector } from "../src/diagnostics.js";
import { SourceManager } from "../src/frontend/source-manager.js";
import { consoleLogger } from "../src/logger.js";
import { resolveAppConfig } from "../src/phases/analysis/app-config.js";
import { formatBuildLogs } from "../src/phases/linker.js";
import { hashString } from "../src/utils/hash.js";

describe("hashString", () => {
  it("produces deterministic hex hashes", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("world"));
    expect(hashString("hello")).toMatch(/^[0-9a-f]+$/);
  });

  it("differs for inputs that share prefixes", () => {
    expect(hashString("a")).not.toBe(hashString("ab"));
  });
});

describe("consoleLogger", () => {
  it("gates debug output on verbose", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const quiet = consoleLogger(false);
      quiet.debug("hidden");
      expect(log).not.toHaveBeenCalled();

      const verbose = consoleLogger(true);
      verbose.debug("shown");
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("time() returns the function result and logs a metric", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const logger = consoleLogger();
      const result = logger.time("phase", () => 42);
      expect(result).toBe(42);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("phase"));
    } finally {
      log.mockRestore();
    }
  });
});

describe("formatBuildLogs", () => {
  it("returns an empty string for no logs", () => {
    expect(formatBuildLogs(undefined)).toBe("");
    expect(formatBuildLogs([])).toBe("");
    expect(formatBuildLogs({ logs: [] })).toBe("");
  });

  it("formats string logs", () => {
    expect(formatBuildLogs(["boom"])).toContain("boom");
  });

  it("formats structured logs with positions", () => {
    const out = formatBuildLogs([
      { message: "something failed", position: { file: "a.ts", line: 3, column: 5 } },
    ]);
    expect(out).toContain("something failed");
    expect(out).toContain("a.ts:3:5");
  });

  it("handles a logs object wrapper", () => {
    expect(formatBuildLogs({ logs: [{ message: "x" }] })).toContain("x");
  });
});

describe("resolveAppConfig", () => {
  const mkContext = () => {
    const d = new DiagnosticCollector();
    return {
      ctx: {
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          time: (_: string, fn: () => unknown) => fn(),
        },
        diagnostics: d,
      },
      d,
    };
  };

  it("returns undefined when the config does not exist", () => {
    const { ctx } = mkContext();
    const result = resolveAppConfig(
      { appConfig: "./missing.config.ts" } as never,
      new SourceManager(),
      ctx as never,
    );
    expect(result).toBeUndefined();
  });

  it("emits an IGN_IO_READ_FAILED warning when the config is unreadable", () => {
    // A directory passes existsSync but fails readFileSync → safeReadFile "".
    const { ctx, d } = mkContext();
    const result = resolveAppConfig(
      { appConfig: "./" } as never,
      new SourceManager(),
      ctx as never,
    );
    expect(result).toBeUndefined();
    expect(d.warnings.some((w) => w.code === DiagnosticCodes.IoReadFailed)).toBe(true);
  });
});
