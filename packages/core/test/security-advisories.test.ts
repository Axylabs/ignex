/**
 * Boot security advisories + write-path hardening pins — production-only
 * advisory warnings, RFC 6265 cookie-name validation on write, and the
 * plaintext-keygen warning outside development.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeCookie } from "../src/http/cookies";
import { reportSecurityAdvisories } from "../src/lifecycle/advisories";

const setProd = () => {
  process.env.NODE_ENV = "production";
};
const restoreEnv = (env: string | undefined) => {
  if (env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;
  delete process.env.IGNEX_SILENCE_ADVISORIES;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("boot security advisories", () => {
  it("warns when production serves without the security-headers plugin", () => {
    const prev = process.env.NODE_ENV;
    setProd();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportSecurityAdvisories([{ name: "cors" } as never]);
      const text = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("security-headers plugin");
      expect(text).toContain("IGNEX_SILENCE_ADVISORIES");
    } finally {
      restoreEnv(prev);
    }
  });

  it("warns for cookie sessions without a CSRF guard", () => {
    const prev = process.env.NODE_ENV;
    setProd();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportSecurityAdvisories([{ name: "session" } as never]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("CSRF guard"))).toBe(true);
    } finally {
      restoreEnv(prev);
    }
  });

  it("stays silent when security + csrf are configured", () => {
    const prev = process.env.NODE_ENV;
    setProd();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportSecurityAdvisories([{ name: "security" } as never, { name: "csrf" } as never]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      restoreEnv(prev);
    }
  });

  it("never fires outside production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportSecurityAdvisories(undefined);
      reportSecurityAdvisories([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      restoreEnv(prev);
    }
  });

  it("IGNEX_SILENCE_ADVISORIES=1 mutes in production", () => {
    const prev = process.env.NODE_ENV;
    setProd();
    process.env.IGNEX_SILENCE_ADVISORIES = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      reportSecurityAdvisories([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      restoreEnv(prev);
    }
  });
});

describe("cookie name validation on write", () => {
  it("accepts RFC 6265 token names (incl. __Host- prefix)", () => {
    expect(() => serializeCookie({ sid: { value: "v" } })).not.toThrow();
    expect(() => serializeCookie({ "__Host-csrf-token": { value: "v" } })).not.toThrow();
    expect(() => serializeCookie({ "a.b_c$d": { value: "v" } })).not.toThrow();
  });

  it("throws on invalid names instead of emitting a dropped cookie", () => {
    expect(() => serializeCookie({ "bad name": { value: "v" } })).toThrow(/cookie name/);
    expect(() => serializeCookie({ "bad;name": { value: "v" } })).toThrow(/cookie name/);
    expect(() => serializeCookie({ "bad=name": { value: "v" } })).toThrow(/cookie name/);
    expect(() => serializeCookie({ "": { value: "v" } })).toThrow(/cookie name/);
  });
});
