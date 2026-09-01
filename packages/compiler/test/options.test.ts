import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticCodes, DiagnosticCollector } from "../src/diagnostics";
import { mergeOptions, validateOptions } from "../src/validate";

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

  it("accepts the production-shape option", () => {
    const d = new DiagnosticCollector();
    const result = validateOptions({ ...valid, production: true }, d);

    expect(result.ok).toBe(true);
    expect(d.errors).toHaveLength(0);
    expect(d.warnings).toHaveLength(0);
    const value = (result as unknown as { value?: Record<string, unknown> }).value;
    expect(value?.production).toBe(true);
  });

  it("treats removed options (router/cluster/inlineHooks) as unknown and strips them", () => {
    // These options were removed — the compiler no longer accepts them as
    // "deprecated" (they are not part of the surface at all). They fall into
    // the unknown-option path: warned + stripped, never fatal.
    const d = new DiagnosticCollector();
    const result = validateOptions(
      { ...valid, router: "bun-native", cluster: true, inlineHooks: true } as never,
      d,
    );

    expect(result.ok).toBe(true);
    expect(d.warnings.some((x) => x.code === DiagnosticCodes.OptionUnknown)).toBe(true);
    expect(d.warnings.some((x) => x.code === DiagnosticCodes.OptionDeprecated)).toBe(false);
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

describe("mergeOptions production-shape error defaults", () => {
  const origNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  });

  it("defaults exposeErrorDetails to false when built with production: true", () => {
    // Regression: an artifact built in an environment where NODE_ENV is unset
    // used to inherit the dev default (`true`) and ship error details to
    // clients. A production shape must default to SAFE error responses.
    delete process.env.NODE_ENV;
    expect(mergeOptions({ ...valid, production: true }).exposeErrorDetails).toBe(false);
    expect(mergeOptions({ ...valid, compile: true }).exposeErrorDetails).toBe(false);
    process.env.NODE_ENV = "production";
    expect(mergeOptions({ ...valid }).exposeErrorDetails).toBe(false);
  });

  it("an explicit exposeErrorDetails wins over the production shape", () => {
    delete process.env.NODE_ENV;
    expect(
      mergeOptions({ ...valid, production: true, exposeErrorDetails: true }).exposeErrorDetails,
    ).toBe(true);
  });

  it("keeps the dev default outside production shapes", () => {
    delete process.env.NODE_ENV;
    expect(mergeOptions({ ...valid }).exposeErrorDetails).toBe(true);
    expect(mergeOptions({ ...valid, production: false }).exposeErrorDetails).toBe(true);
  });
});
