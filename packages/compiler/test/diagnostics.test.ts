import { describe, expect, it } from "vitest";
import {
  DiagnosticCodes,
  DiagnosticCollector,
  formatDiagnostic,
  getCodeFrame,
} from "../src/diagnostics";

describe("DiagnosticCollector", () => {
  it("collects warnings, errors, and info separately", () => {
    const d = new DiagnosticCollector();

    d.warn({ code: DiagnosticCodes.DeadRoute, message: "dead route" });
    d.error({ code: DiagnosticCodes.LinkFailed, message: "link failed" });
    d.info({ code: DiagnosticCodes.SyncLimited, message: "sync only" });

    expect(d.count).toBe(3);
    expect(d.warnings).toHaveLength(1);
    expect(d.errors).toHaveLength(1);
    expect(d.infos).toHaveLength(1);
    expect(d.hasErrors).toBe(true);
  });

  it("reports no errors when only warnings are present", () => {
    const d = new DiagnosticCollector();
    d.warn({ code: DiagnosticCodes.DeadRoute, message: "x" });
    expect(d.hasErrors).toBe(false);
  });

  it("attaches optional file, position, and frame", () => {
    const d = new DiagnosticCollector();
    d.warn({
      code: DiagnosticCodes.IoReadFailed,
      message: "read failed",
      file: "a.ts",
      position: { line: 1, column: 0 },
      frame: "> 1 | code\n  | ^",
    });

    const diag = d.all[0];
    expect(diag).toBeDefined();
    if (diag) {
      expect(diag.file).toBe("a.ts");
      expect(diag.position).toEqual({ line: 1, column: 0 });
      expect(diag.frame).toContain("^");
    }
  });
});

describe("getCodeFrame", () => {
  it("renders a caret at the offending column", () => {
    const source = "const a = 1;\nconst b = 2;";
    const frame = getCodeFrame(source, { line: 1, column: 4 });
    expect(frame).toBeDefined();
    if (frame) {
      expect(frame).toContain("const a = 1;");
      expect(frame).toContain("^");
    }
  });

  it("returns undefined for out-of-range lines", () => {
    expect(getCodeFrame("a", { line: 99, column: 0 })).toBeUndefined();
  });
});

describe("formatDiagnostic", () => {
  it("includes severity, location, message, and code", () => {
    const out = formatDiagnostic({
      code: "FLX_TEST",
      severity: "error",
      message: "boom",
      file: "a.ts",
      position: { line: 2, column: 3 },
    });

    expect(out).toContain("error");
    expect(out).toContain("a.ts:2:3");
    expect(out).toContain("boom");
    expect(out).toContain("FLX_TEST");
  });
});
