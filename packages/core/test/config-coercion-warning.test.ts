/**
 * Config coercion observability — an invalid typed env value falls back to
 * the schema default (availability-first) but now WARNS once per env var,
 * so a typo'd `PORT=3O00` or malformed JSON is visible in production logs
 * instead of silently swallowed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineConfig } from "../src/platform/config";

const SCHEMA = {
  port: { type: "number", default: 3000, env: "PORT" },
  debug: { type: "boolean", default: false, env: "DEBUG" },
  flags: { type: "json", default: { a: 1 }, env: "FLAGS" },
  name: { type: "string", default: "app", env: "NAME" },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PORT;
  delete process.env.DEBUG;
  delete process.env.FLAGS;
});

describe("config coercion warnings", () => {
  it("warns once per env var on an invalid number and keeps the default", () => {
    process.env.PORT = "3O00";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = defineConfig(SCHEMA);
    expect(config.port).toBe(3000);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("invalid number value for PORT")),
    ).toBe(true);
    // Second resolution warns again only because this is a fresh spy; the
    // once-per-var gate is module-level — assert no repeat within one warn
    // spy by resolving again with a restored spy count.
    const callsAfterFirst = warn.mock.calls.length;
    defineConfig(SCHEMA);
    expect(warn.mock.calls.length).toBe(callsAfterFirst);
  });

  it("warns on an invalid boolean and keeps the default", () => {
    process.env.DEBUG = "yes-please";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = defineConfig(SCHEMA);
    expect(config.debug).toBe(false);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("invalid boolean value for DEBUG")),
    ).toBe(true);
  });

  it("warns on malformed JSON and keeps the default", () => {
    process.env.FLAGS = "{not-json";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = defineConfig(SCHEMA);
    expect(config.flags).toEqual({ a: 1 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("invalid json value for FLAGS"))).toBe(
      true,
    );
  });

  it("valid values never warn", () => {
    process.env.PORT = "8080";
    process.env.DEBUG = "true";
    process.env.FLAGS = '{"b":2}';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = defineConfig(SCHEMA);
    expect(config.port).toBe(8080);
    expect(config.debug).toBe(true);
    expect(config.flags).toEqual({ b: 2 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("string fields never coerce or warn", () => {
    process.env.NAME = "3O00";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(defineConfig(SCHEMA).name).toBe("3O00");
    expect(warn).not.toHaveBeenCalled();
  });
});
