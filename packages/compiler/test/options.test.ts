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

  it("accepts the standalone-executable options (compile / binaryOutfile / bytecode)", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions(
      { ...valid, compile: true, binaryOutfile: "app-server", bytecode: false },
      d,
    );

    expect(result.ok).toBe(true);
    expect(d.errors).toHaveLength(0);
    expect(d.warnings).toHaveLength(0);
    const value = (result as unknown as { value?: Record<string, unknown> }).value;
    expect(value?.compile).toBe(true);
    expect(value?.binaryOutfile).toBe("app-server");
    expect(value?.bytecode).toBe(false);
  });

  it("warns on deprecated options and strips them", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions({ ...valid, router: "bun-native" } as never, d);

    expect(result.ok).toBe(true);
    expect(d.warnings.some((x) => x.code === DiagnosticCodes.OptionDeprecated)).toBe(true);
  });

  it("warns on unknown options, strips them, and still validates", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions({ ...valid, notARealOption: 1 } as never, d);

    expect(result.ok).toBe(true);
    expect(d.warnings.some((x) => x.code === DiagnosticCodes.OptionUnknown)).toBe(true);
    const value = (result as unknown as { value?: Record<string, unknown> }).value;
    expect(value?.notARealOption).toBeUndefined();
  });

  it("warns on removed (formerly dead) options", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions({ ...valid, enableStrictMethods: true } as never, d);

    expect(result.ok).toBe(true);
    expect(d.warnings.some((x) => x.code === DiagnosticCodes.OptionUnknown)).toBe(true);
  });
});
