import { describe, expect, it } from "vitest";
import { DiagnosticCodes, DiagnosticCollector } from "../src/diagnostics";
import { validateOptions } from "../src/validate";

const valid = {
  routesDir: "./routes",
  outDir: "./.out",
  outFile: "server.js",
};

describe("validateOptions", () => {
  it("accepts valid options without diagnostics", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions(valid, d);

    expect(result.ok).toBe(true);
    expect(d.errors).toHaveLength(0);
    expect(d.warnings).toHaveLength(0);
  });

  it("warns on deprecated options and strips them", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions({ ...valid, router: "bun-native" } as never, d);

    expect(result.ok).toBe(true);
    expect(d.warnings.some((x) => x.code === DiagnosticCodes.OptionDeprecated)).toBe(true);
  });

  it("rejects unknown options with a diagnostic", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions({ ...valid, notARealOption: 1 } as never, d);

    expect(result.ok).toBe(false);
    expect(d.errors.some((x) => x.code === DiagnosticCodes.OptionUnknown)).toBe(true);
  });

  it("rejects removed (formerly dead) options", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions({ ...valid, enableStrictMethods: true } as never, d);

    expect(result.ok).toBe(false);
    expect(d.errors.some((x) => x.code === DiagnosticCodes.OptionUnknown)).toBe(true);
  });
});
