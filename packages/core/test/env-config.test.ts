/**
 * Env-config validation layer tests: TypeBox schemas, defaults, required /
 * optional semantics, secret redaction, and .env.example generation.
 */

import { defineEnv, EnvError, EnvIssueCodes, envExampleFromSchema, validateEnv } from "@ignex/core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

const schema = Type.Object({
  NODE_ENV: Type.Optional(Type.String({ default: "development" })),
  PORT: Type.Optional(Type.Integer({ default: 3000, minimum: 1, maximum: 65535 })),
  DEBUG: Type.Optional(Type.Boolean({ default: false })),
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
  DATABASE_URL: Type.String(),
});

describe("validateEnv", () => {
  it("applies defaults and coerces env-style strings", () => {
    const result = validateEnv(schema, {
      source: {
        PORT: "8080",
        DEBUG: "yes",
        DATABASE_URL: "postgres://db",
        SESSION_SECRET: "s3cret",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      NODE_ENV: "development",
      PORT: 8080,
      DEBUG: true,
      SESSION_SECRET: "s3cret",
      DATABASE_URL: "postgres://db",
    });
    expect(result.issues).toEqual([]);
  });

  it("supports 1/0/on/off boolean formats", () => {
    const a = validateEnv(schema, { source: { DEBUG: "1", DATABASE_URL: "x" } });
    expect(a.ok).toBe(true);
    expect(a.value?.DEBUG).toBe(true);
    const b = validateEnv(schema, { source: { DEBUG: "off", DATABASE_URL: "x" } });
    expect(b.ok).toBe(true);
    expect(b.value?.DEBUG).toBe(false);
  });

  it("reports a missing required variable as an error", () => {
    const result = validateEnv(schema, { source: {} });
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: EnvIssueCodes.MissingRequired,
        severity: "error",
        key: "DATABASE_URL",
      }),
    );
  });

  it("warns (but still succeeds) on an unset optional variable without a default", () => {
    const result = validateEnv(schema, { source: { DATABASE_URL: "x" } });
    expect(result.ok).toBe(true);
    expect(result.value?.SESSION_SECRET).toBeUndefined();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: EnvIssueCodes.MissingOptional,
        severity: "warning",
        key: "SESSION_SECRET",
      }),
    );
  });

  it("reports an invalid value with the actual (non-secret) value", () => {
    const result = validateEnv(schema, { source: { DATABASE_URL: "x", PORT: "abc" } });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: EnvIssueCodes.Invalid,
        severity: "error",
        key: "PORT",
        expected: "integer",
        got: JSON.stringify("abc"),
      }),
    );
  });

  it("never leaks a secret value into the report", () => {
    const secretSchema = Type.Object({
      TOKEN: Type.String({ minLength: 100, metadata: { secret: true } }),
    });
    const result = validateEnv(secretSchema, { source: { TOKEN: "super-secret" } });
    const issue = result.issues.find((i) => i.key === "TOKEN");
    expect(issue?.secret).toBe(true);
    expect(issue).not.toHaveProperty("got");
    expect(JSON.stringify(result.issues)).not.toContain("super-secret");
  });

  it("ignores unrelated environment variables not declared in the schema", () => {
    const result = validateEnv(schema, {
      source: { DATABASE_URL: "x", PATH: "/usr/bin", HOME: "/root" },
    });
    expect(result.ok).toBe(true);
  });

  it("parses JSON array/object env values", () => {
    const jsonSchema = Type.Object({
      FEATURES: Type.Array(Type.String(), { default: [] }),
      META: Type.Object({ region: Type.String() }, { default: { region: "us" } }),
    });
    const ok = validateEnv(jsonSchema, {
      source: { FEATURES: '["a","b"]', META: '{"region":"eu"}' },
    });
    expect(ok.ok).toBe(true);
    expect(ok.value?.FEATURES).toEqual(["a", "b"]);
    expect(ok.value?.META).toEqual({ region: "eu" });

    const bad = validateEnv(jsonSchema, { source: { FEATURES: "not-json" } });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.code === EnvIssueCodes.Invalid)).toBe(true);
  });
});

describe("defineEnv", () => {
  it("returns a frozen, defaulted config", () => {
    const env = defineEnv(schema, {
      loadEnv: false,
      source: { DATABASE_URL: "postgres://db" },
    });
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("throws a structured EnvError on missing required / invalid", () => {
    expect(() =>
      defineEnv(schema, { loadEnv: false, source: { DATABASE_URL: "x", PORT: "abc" } }),
    ).toThrowError(EnvError);
    try {
      defineEnv(schema, { loadEnv: false, source: { PORT: "abc" } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const envError = error as EnvError;
      expect(envError.code).toBe("IGN_ENV_VALIDATION_FAILED");
      expect(envError.issues.some((i) => i.code === EnvIssueCodes.MissingRequired)).toBe(true);
      expect(envError.issues.some((i) => i.code === EnvIssueCodes.Invalid)).toBe(true);
    }
  });

  it("upgrades warnings to errors in strict mode", () => {
    expect(() =>
      defineEnv(schema, { loadEnv: false, strict: true, source: { DATABASE_URL: "x" } }),
    ).toThrowError(EnvError);
  });

  it("does not throw on warnings in the default (non-strict) mode", () => {
    const env = defineEnv(schema, { loadEnv: false, source: { DATABASE_URL: "x" } });
    expect(env.PORT).toBe(3000);
  });

  it("routes warnings through the onWarning sink", () => {
    const warnings: string[] = [];
    defineEnv(schema, {
      loadEnv: false,
      source: { DATABASE_URL: "x" },
      onWarning: (issue) => warnings.push(issue.key),
    });
    expect(warnings).toContain("SESSION_SECRET");
  });

  it("reads process.env when no source is provided", () => {
    const old = process.env.ENVCONF_PORT;
    process.env.ENVCONF_PORT = "9999";
    const localSchema = Type.Object({
      ENVCONF_PORT: Type.Optional(Type.Integer({ default: 1 })),
    });
    try {
      const env = defineEnv(localSchema, { loadEnv: false });
      expect(env.ENVCONF_PORT).toBe(9999);
    } finally {
      if (old === undefined) delete process.env.ENVCONF_PORT;
      else process.env.ENVCONF_PORT = old;
    }
  });
});

describe("envExampleFromSchema", () => {
  it("renders required/optional sections with defaults and blank secrets", () => {
    const example = envExampleFromSchema(schema);
    expect(example).toContain("# REQUIRED — DATABASE_URL");
    expect(example).toContain("DATABASE_URL=your-value");
    expect(example).toContain("# OPTIONAL · secret — SESSION_SECRET");
    expect(example).toContain("SESSION_SECRET=");
    expect(example).toContain("# OPTIONAL — PORT (default: 3000)");
    expect(example).toContain("PORT=3000");
  });
});

describe("@ignex/core/env subpath", () => {
  it("re-exports Type alongside defineEnv for single-import DX", async () => {
    const mod = await import("@ignex/core/env");
    expect(typeof mod.Type.Object).toBe("function");
    expect(typeof mod.defineEnv).toBe("function");
    expect(typeof mod.validateEnv).toBe("function");
    expect(typeof mod.envExampleFromSchema).toBe("function");
  });
});

describe("writeEnvKeys", () => {
  it("writes appended keys with owner-only file permissions (0600)", async () => {
    const { writeEnvKeys } = await import("../src/platform/env.js");
    const { mkdtempSync, statSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ignex-env-"));
    try {
      const path = join(dir, ".env");
      const appended = writeEnvKeys({ IGNEX_TEST_KEY_A: "a", IGNEX_TEST_KEY_B: "b" }, path);
      expect(appended).toBe(2);
      // Idempotent: existing keys are never rewritten.
      expect(writeEnvKeys({ IGNEX_TEST_KEY_A: "other" }, path)).toBe(0);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
